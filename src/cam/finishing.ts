import ClipperLib from 'clipper-lib'
import type { Point } from '../models/geometry'
import { arcPoints, area, cornerReliefScale, distance, fromClipper, pathMetric, scale, toClipper, tolerance } from './geometry'

export const finishingAllowanceMm = 0.3

// Include the final dogbone footprints before reserving stock, so roughing also
// leaves material on the relief walls instead of cutting them to size early.
export function machiningOutline(points: Point[], centers: Point[], toolRadius: number): Point[] {
  if (!centers.length) return points
  const clip = new ClipperLib.Clipper()
  const polygons = [points, ...centers.map(center => arcPoints(center, toolRadius * cornerReliefScale, 0, Math.PI * 2).slice(0, -1))]
  for (const polygon of polygons) {
    const path = toClipper(polygon)
    if (!ClipperLib.Clipper.Orientation(path)) path.reverse()
    clip.AddPath(path, ClipperLib.PolyType.ptSubject, true)
  }
  const result: ClipperLib.Paths = []
  clip.Execute(ClipperLib.ClipType.ctUnion, result, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  if (result.length !== 1) throw new Error('Corner reliefs split the machining outline.')
  return fromClipper(result[0])
}

// A pocket's final offset can contain several disconnected regions. Keep each
// perimeter, without repeating all of its interior clearing loops for finishing.
export function pocketPerimeters(points: Point[], radius: number): Point[][] {
  const path = toClipper(points)
  if (!ClipperLib.Clipper.Orientation(path)) path.reverse()
  const co = new ClipperLib.ClipperOffset(2, tolerance * scale)
  co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
  const result: ClipperLib.Paths = []
  co.Execute(result, -radius * scale)
  if (!result.length) throw new Error('Pocket is too small for the cutter and requested allowance.')
  return result.map(path => {
    const points = fromClipper(path)
    if (area(points) > 0) points.reverse()
    return points
  })
}

export function nearestPathPosition(path: Point[], point: Point): number {
  const metric = pathMetric(path)
  let best = Infinity, position = 0
  for (let i = 0; i < path.length; i++) {
    const a = path[i], b = path[(i + 1) % path.length]
    const dx = b.x - a.x, dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    const separation = distance(point, { x: a.x + t * dx, y: a.y + t * dy })
    if (separation < best) { best = separation; position = metric.cumulative[i] + t * (metric.cumulative[i + 1] - metric.cumulative[i]) }
  }
  return position % metric.length
}

// Project the same physical tabs onto the roughing contour. Padding keeps the
// original tab width intact on curved walls despite the change in radius.
export function roughingTabs(finish: Point[], rough: Point[], tabs: Array<[number, number]>): Array<[number, number]> {
  const finishMetric = pathMetric(finish), roughLength = pathMetric(rough).length
  const intervals: Array<[number, number]> = []
  for (const [a, b] of tabs) {
    const start = nearestPathPosition(rough, finishMetric.at(a)) - finishingAllowanceMm
    let end = nearestPathPosition(rough, finishMetric.at(b)) + finishingAllowanceMm
    if (end < start) end += roughLength
    for (const shift of [-roughLength, 0, roughLength]) {
      const from = Math.max(0, start + shift), to = Math.min(roughLength, end + shift)
      if (to > from) intervals.push([from, to])
    }
  }
  const merged: Array<[number, number]> = []
  for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1)
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1])
    else merged.push(interval)
  }
  return merged
}
