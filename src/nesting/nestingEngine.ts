import ClipperLib from 'clipper-lib'
import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'
import type { Bounds, Point } from '../models/geometry'
import { boundsPolygon, convexHull, expandedFootprint, footprintsOverlap, fromPath, instanceFootprint, nestingRotations, polygonBounds, toPath } from '../gcode/footprint'

interface PlacedShape { sheetIndex: number; bounds: Bounds; points: Point[] }

function candidatePositions(sheet: Sheet, placed: PlacedShape[], sheetIndex: number, points: Point[]): Point[] {
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
    // No-fit polygons describe forbidden positions of the candidate's origin.
    // For convex envelopes the Minkowski difference is the hull of vertex differences.
    // Avoid a general polygon union of every edge pair for long, detailed CNC outlines.
    const expanded = fromPath(expandedFootprint(item.points, sheet.spacing + 0.002))
    obstacles.push(toPath(convexHull(expanded.flatMap(a => points.map(b => ({ x: a.x - b.x, y: a.y - b.y }))))))
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
    .map(p => [`${p.x},${p.y}`, p])).values()].sort((a, b) => a.y - b.y || a.x - b.x)
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

export function autoNest(parts: Part[], sheet: Sheet): PartInstance[] {
  const instances = sheet.instances.map(instance => ({ ...instance }))
  const placed: PlacedShape[] = []
  const add = (part: Part, instance: PartInstance) => {
    const points = instanceFootprint(part, instance)
    placed.push({ sheetIndex: instance.sheetIndex, points, bounds: polygonBounds(points) })
  }
  for (const instance of instances) {
    const part = parts.find(p => p.id === instance.partId)
    if (instance.locked && part) add(part, instance)
  }
  for (const instance of instances) {
    if (instance.locked) continue
    const part = parts.find(p => p.id === instance.partId)
    if (!part) continue
    const options = orientations(part, instance.rotation).filter(({ bounds }) => bounds.maxX <= sheet.width - sheet.borderSpacing * 2 + 0.000001 && bounds.maxY <= sheet.height - sheet.borderSpacing * 2 + 0.000001)
    let best: { instance: PartInstance; score: number[] } | undefined
    const lastSheet = Math.max(0, ...placed.map(p => p.sheetIndex)) + 1
    for (let sheetIndex = 0; !best && sheetIndex <= lastSheet; sheetIndex++) {
      const onSheet = placed.filter(p => p.sheetIndex === sheetIndex)
      const occupiedTop = Math.max(0, ...onSheet.map(p => p.bounds.maxY))
      const occupiedRight = Math.max(0, ...onSheet.map(p => p.bounds.maxX))
      for (const { rotation, points, bounds, offset } of options) {
        for (const point of candidatePositions(sheet, placed, sheetIndex, points)) {
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
    }
    if (best) { Object.assign(instance, best.instance); add(part, instance) }
  }
  return instances
}
