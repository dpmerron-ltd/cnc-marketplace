import ClipperLib from 'clipper-lib'
import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'
import type { Bounds, Point } from '../models/geometry'
import { boundsPolygon, expandedFootprint, footprintScale, footprintsOverlap, fromPath, instanceFootprint, nestingRotations, polygonBounds, toPath } from '../gcode/footprint'
import { convexSum } from './convexSum'
import { selectMaterialParts } from '../gcode/materialSelection'

interface PlacedShape { sheetIndex: number; bounds: Bounds; points: Point[]; localPoints: Point[]; origin: Point }
type NoFit = (obstacle: PlacedShape, candidate: Point[]) => ClipperLib.Path

function insideNoFit(point: ClipperLib.IntPoint, path: ClipperLib.Path): boolean {
  if (ClipperLib.Clipper.PointInPolygon(point, path) !== 1) return false
  // Retain boundary candidates for the exact collision check, including legacy exact-spacing placements.
  const margin = 0.003 * footprintScale
  return path.every((a, i) => {
    const b = path[(i + 1) % path.length], dx = b.X - a.X, dy = b.Y - a.Y
    return Math.abs(dx * (point.Y - a.Y) - dy * (point.X - a.X)) > margin * Math.hypot(dx, dy)
  })
}

function candidatePositions(sheet: Sheet, placed: PlacedShape[], sheetIndex: number, points: Point[], noFit: NoFit): Point[] {
  const bounds = polygonBounds(points)
  const width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY
  const border = sheet.borderSpacing
  const maxX = sheet.width - border - width, maxY = sheet.height - border - height
  const xs = new Set<number>([border]), ys = new Set<number>([border])
  const obstacles: ClipperLib.Paths = []
  for (const item of placed) {
    if (item.sheetIndex !== sheetIndex) continue
    xs.add(item.bounds.maxX + sheet.spacing)
    xs.add(item.bounds.minX - width - sheet.spacing)
    ys.add(item.bounds.maxY + sheet.spacing)
    ys.add(item.bounds.minY - height - sheet.spacing)
    obstacles.push(noFit(item, points))
  }
  const candidates = [...xs].flatMap(x => [...ys].map(y => ({ x: Math.max(border, x), y: Math.max(border, y) })))
  if (obstacles.length) {
    const clipper = new ClipperLib.Clipper()
    clipper.AddPath(toPath(boundsPolygon({ minX: border, minY: border, maxX, maxY })), ClipperLib.PolyType.ptSubject, true)
    clipper.AddPaths(obstacles, ClipperLib.PolyType.ptClip, true)
    const free: ClipperLib.Paths = []
    clipper.Execute(ClipperLib.ClipType.ctDifference, free, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
    candidates.push(...free.flatMap(fromPath))
    // Keep boundary crossings when a part fits exactly across one sheet dimension.
    for (const path of obstacles.map(fromPath)) for (let i = 0; i < path.length; i++) {
      const a = path[i], b = path[(i + 1) % path.length]
      candidates.push(a)
      for (const x of [border, maxX]) if (a.x !== b.x) {
        const t = (x - a.x) / (b.x - a.x)
        if (t >= 0 && t <= 1) candidates.push({ x, y: a.y + t * (b.y - a.y) })
      }
      for (const y of [border, maxY]) if (a.y !== b.y) {
        const t = (y - a.y) / (b.y - a.y)
        if (t >= 0 && t <= 1) candidates.push({ x: a.x + t * (b.x - a.x), y })
      }
    }
  }
  return [...new Map(candidates.filter(p => p.x >= border - 0.00001 && p.y >= border - 0.00001 && p.x <= maxX + 0.00001 && p.y <= maxY + 0.00001)
    .map(p => ({ x: Math.max(border, Math.min(maxX, p.x)), y: Math.max(border, Math.min(maxY, p.y)) }))
    .map(p => [`${p.x.toFixed(4)},${p.y.toFixed(4)}`, p])).values()]
    .filter(point => { const [p] = toPath([point]); return !obstacles.some(path => insideNoFit(p, path)) })
    .sort((a, b) => a.y - b.y || a.x - b.x)
}

function orientations(part: Part, current = 0) {
  if (Math.abs(part.width - (part.originalBounds.maxX - part.originalBounds.minX)) > 0.001 || Math.abs(part.height - (part.originalBounds.maxY - part.originalBounds.minY)) > 0.001) return []
  return nestingRotations(part, current).map(rotation => {
    const points = instanceFootprint(part, { id: '', partId: part.id, sheetIndex: 0, x: 0, y: 0, rotation, locked: false })
    const bounds = polygonBounds(points)
    const offset = { x: -bounds.minX, y: -bounds.minY }
    const normalized = points.map(p => ({ x: p.x + offset.x, y: p.y + offset.y }))
    return { rotation, points: normalized, bounds: polygonBounds(normalized), offset }
  })
}

export function partFitsSheet(part: Part, sheet: Sheet): boolean {
  return orientations(part).some(({ bounds }) => bounds.maxX <= sheet.width - sheet.borderSpacing * 2 + 0.000001 && bounds.maxY <= sheet.height - sheet.borderSpacing * 2 + 0.000001)
}

export function autoNest(parts: Part[], sheet: Sheet, onProgress?: (completed: number, total: number) => void): PartInstance[] {
  const selection = selectMaterialParts(parts, sheet)
  if (selection.errors.length) throw new Error(selection.errors.join(' '))
  parts = selection.parts
  const instances = sheet.instances.map(instance => ({ ...instance }))
  const placed: PlacedShape[] = []
  const orientationCache = new Map<Part, ReturnType<typeof orientations>>()
  const noFitCache = new WeakMap<Point[], WeakMap<Point[], ClipperLib.Path>>()
  const failedFits = new Map<Part, Map<number, { revision: number; orientations: Set<Point[]> }>>()
  function optionsFor(part: Part, current: number) {
    let options = orientationCache.get(part)
    if (!options) { options = orientations(part, current); orientationCache.set(part, options) }
    if (!options.some(option => option.rotation === current)) {
      const extra = orientations(part, current).find(option => option.rotation === current)
      if (extra) options.push(extra)
    }
    return [...options].sort((a, b) => Number(b.rotation === current) - Number(a.rotation === current))
  }
  const noFit: NoFit = (obstacle, candidate) => {
    let entries = noFitCache.get(obstacle.localPoints)
    if (!entries) { entries = new WeakMap(); noFitCache.set(obstacle.localPoints, entries) }
    let path = entries.get(candidate)
    if (!path) {
      // Shape-pair geometry is translation invariant; calculate once, not for every copy.
      const expanded = fromPath(expandedFootprint(obstacle.localPoints, sheet.spacing + 0.002))
      path = toPath(convexSum(expanded, candidate.map(p => ({ x: -p.x, y: -p.y }))))
      entries.set(candidate, path)
    }
    const [origin] = toPath([obstacle.origin])
    return path.map(p => ({ X: p.X + origin.X, Y: p.Y + origin.Y }))
  }
  const add = (part: Part, instance: PartInstance) => {
    const option = optionsFor(part, instance.rotation).find(option => option.rotation === instance.rotation)
    const localPoints = option?.points ?? instanceFootprint(part, { ...instance, x: 0, y: 0 })
    const origin = { x: instance.x - (option?.offset.x ?? 0), y: instance.y - (option?.offset.y ?? 0) }
    const points = localPoints.map(p => ({ x: p.x + origin.x, y: p.y + origin.y }))
    placed.push({ sheetIndex: instance.sheetIndex, points, localPoints, origin, bounds: polygonBounds(points) })
  }
  for (const instance of instances) {
    const part = parts.find(p => p.id === instance.partId)
    if (instance.locked && part) add(part, instance)
  }
  let completed = 0
  const total = instances.filter(instance => !instance.locked).length
  onProgress?.(completed, total)
  for (const instance of instances) {
    if (instance.locked) continue
    const part = parts.find(p => p.id === instance.partId)
    if (!part) continue
    const options = optionsFor(part, instance.rotation).filter(({ bounds }) => bounds.maxX <= sheet.width - sheet.borderSpacing * 2 + 0.000001 && bounds.maxY <= sheet.height - sheet.borderSpacing * 2 + 0.000001)
    let best: { instance: PartInstance; score: number[] } | undefined
    const lastSheet = Math.max(0, ...placed.map(p => p.sheetIndex)) + 1
    for (let sheetIndex = 0; !best && sheetIndex <= lastSheet; sheetIndex++) {
      const onSheet = placed.filter(p => p.sheetIndex === sheetIndex)
      const previousFailure = failedFits.get(part)?.get(sheetIndex)
      const failedOrientations = previousFailure?.revision === onSheet.length ? previousFailure.orientations : new Set<Point[]>()
      const occupiedTop = Math.max(0, ...onSheet.map(p => p.bounds.maxY))
      const occupiedRight = Math.max(0, ...onSheet.map(p => p.bounds.maxX))
      for (const { rotation, points, bounds, offset } of options) {
        // An unchanged sheet cannot produce a new result for the same shape and angle.
        if (failedOrientations.has(points)) continue
        for (const point of candidatePositions(sheet, placed, sheetIndex, points, noFit)) {
          const top = Math.max(point.y + bounds.maxY, occupiedTop)
          const right = Math.max(point.x + bounds.maxX, occupiedRight)
          const score = [top, right, point.y, point.x, bounds.maxX * bounds.maxY]
          const difference = best ? score.findIndex((value, i) => Math.abs(value - best!.score[i]) > 0.001) : -1
          if (best && (difference < 0 || score[difference] >= best.score[difference])) continue
          const translated = points.map(p => ({ x: p.x + point.x, y: p.y + point.y }))
          if (onSheet.some(other => footprintsOverlap(other.points, translated, sheet.spacing))) continue
          best = { instance: { ...instance, sheetIndex, rotation, x: point.x + offset.x, y: point.y + offset.y }, score }
        }
      }
      if (!best) {
        let failures = failedFits.get(part)
        if (!failures) { failures = new Map(); failedFits.set(part, failures) }
        for (const option of options) failedOrientations.add(option.points)
        failures.set(sheetIndex, { revision: onSheet.length, orientations: failedOrientations })
      }
    }
    if (best) { Object.assign(instance, best.instance); add(part, instance) }
    onProgress?.(++completed, total)
  }
  return instances
}
