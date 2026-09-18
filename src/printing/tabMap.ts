import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import type { Bounds, Point } from '../models/geometry'
import { isFiniteBounds } from '../models/geometry'
import { numberSheetParts, partNumberText } from '../labels/partLabels'
import { simulateGCode, type SimulatedMove } from '../gcode/simulator'
import { instanceBounds, transformLocalPoint } from '../gcode/transform'

export interface TabLocation {
  points: Point[]
  center: Point
  z: number
  operation: string
  inferred: boolean
}
export interface TabMapPart {
  number: string
  name: string
  sheetIndex: number
  bounds: Bounds
  rotation: number
  paths: Point[][]
  tabs: TabLocation[]
  warnings: string[]
}
export interface TabMap {
  name: string
  order: string
  width: number
  height: number
  sheetCount: number
  parts: TabMapPart[]
}

const epsilon = 0.001
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const key = (points: Point[]) => points.map(p => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join(';')

function midpoint(points: Point[]): Point {
  const lengths = points.slice(1).map((p, i) => distance(points[i], p))
  let remaining = lengths.reduce((a, b) => a + b, 0) / 2
  for (const [i, length] of lengths.entries()) {
    if (remaining <= length && length > 0) return { x: points[i].x + (points[i + 1].x - points[i].x) * remaining / length, y: points[i].y + (points[i + 1].y - points[i].y) * remaining / length }
    remaining -= length
  }
  return points[0]
}

export function locatePartTabs(part: Part) {
  const simulation = simulateGCode(part.gcode)
  if (simulation.errors.length) throw new Error(`${part.name}: cannot map tabs because the source simulation has errors.`)
  const body = new Set(part.parsed.bodyLines.map(line => line.lineNumber + 1))
  const moves = simulation.moves.filter(move => body.has(move.lineNumber))
  const paths = new Map<string, Point[]>()
  for (const move of moves) {
    if (move.type === 'rapid' || Math.min(move.start.z, move.end.z) >= 0) continue
    paths.set(key(move.points), move.points)
  }
  const groups: Array<{ name: string; contour: boolean; moves: SimulatedMove[]; markers: Set<number> }> = []
  let group = { name: 'Unclassified machining', contour: false, moves: [] as SimulatedMove[], markers: new Set<number>() }
  groups.push(group)
  const byLine = new Map(moves.map(move => [move.lineNumber, move]))
  let tabMarker = false
  for (const line of part.parsed.bodyLines) {
    const operation = line.raw.trim().match(/^\(No\.\s*\d+\s+(.+?)\s+machining:\s*(.*?)\)$/i)
    if (operation) {
      group = { name: operation[2], contour: /^(outside|inside|part|hole)$/i.test(operation[1]), moves: [], markers: new Set() }
      groups.push(group)
      tabMarker = false
    }
    if (/^\(Tab \d+\)$/i.test(line.raw.trim())) tabMarker = true
    const move = byLine.get(line.lineNumber + 1)
    if (move) {
      group.moves.push(move)
      if (tabMarker) group.markers.add(move.lineNumber)
      tabMarker = false
    }
  }
  const tabs: TabLocation[] = []
  const warnings: string[] = []
  for (const operation of groups) {
    if (!operation.contour) {
      if (operation === groups[0] && operation.moves.some(move => move.end.z < 0)) warnings.push('Unclassified source machining: tab locations cannot be identified reliably.')
      continue
    }
    const cutMoves = operation.moves.filter(move => move.type !== 'rapid')
    const deepest = cutMoves.reduce((z, move) => Math.min(z, move.start.z, move.end.z), 0)
    const found = new Set<string>()
    // Only lifts from the final contour depth count; earlier passes can traverse the same span.
    for (const [i, lift] of operation.moves.entries()) {
      if (Math.abs(lift.start.z - deepest) > epsilon || lift.end.z <= lift.start.z + epsilon || lift.end.z >= -epsilon || distance(lift.start, lift.end) > epsilon) continue
      const points: Point[] = [lift.end]
      for (const move of operation.moves.slice(i + 1)) {
        if (move.type === 'rapid' || Math.abs(move.start.z - lift.end.z) > epsilon || Math.abs(move.end.z - lift.end.z) > epsilon) break
        if (move.lengthMm > epsilon) points.push(...move.points.slice(1))
      }
      if (points.length < 2 || points.slice(1).reduce((sum, p, j) => sum + distance(points[j], p), 0) < epsilon) continue
      const forward = key(points), reverse = key([...points].reverse())
      if (found.has(forward) || found.has(reverse)) continue
      found.add(forward)
      tabs.push({ points, center: midpoint(points), z: lift.end.z, operation: operation.name, inferred: !operation.markers.has(lift.lineNumber) })
    }
  }
  if (tabs.some(tab => tab.inferred)) warnings.push('Imported NC: locations inferred from final-depth contour lifts. Verify against the cut parts.')
  if (!tabs.length) warnings.push('No tab locations identified. This does not prove that the component has no tabs.')
  return { paths: [...paths.values()], tabs, warnings }
}

export function buildTabMap(parts: Part[], input: Sheet): TabMap {
  if (![input.width, input.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('Tab maps require valid sheet dimensions.')
  if (!input.instances.length) throw new Error('Place parts on the sheet before downloading a tab map.')
  const sheet = numberSheetParts(input)
  const cache = new Map<string, ReturnType<typeof locatePartTabs>>()
  return {
    name: sheet.name.trim() || 'Untitled Sheet', order: sheet.orderNumber?.trim() || '-', width: sheet.width, height: sheet.height,
    sheetCount: Math.max(...sheet.instances.map(instance => instance.sheetIndex)) + 1,
    parts: [...sheet.instances].sort((a, b) => a.sheetIndex - b.sheetIndex).map(instance => {
      const part = parts.find(part => part.id === instance.partId)
      if (!part) throw new Error('A placed component is missing. Reopen export after restoring or removing it.')
      const bounds = instanceBounds(part, instance)
      if (!isFiniteBounds(bounds)) throw new Error(`${part.name}: invalid machining bounds.`)
      if (!cache.has(part.id)) cache.set(part.id, locatePartTabs(part))
      const source = cache.get(part.id)!
      const transform = (point: Point) => transformLocalPoint(part, instance, point)
      return {
        number: partNumberText(instance.partNumber!), name: part.name, sheetIndex: instance.sheetIndex, bounds, rotation: instance.rotation,
        paths: source.paths.map(path => path.map(transform)),
        tabs: source.tabs.map(tab => ({ ...tab, points: tab.points.map(transform), center: transform(tab.center) })), warnings: source.warnings,
      }
    }),
  }
}
