import { convexHull } from '../gcode/footprint'
import type { Point } from '../models/geometry'

// Convex Minkowski sum: merge edge directions, rather than allocate every vertex pair.
// Inputs are convex envelopes; hull normalization also removes repeated/collinear vertices.
export function convexSum(first: Point[], second: Point[]): Point[] {
  const prepare = (points: Point[]) => {
    const hull = convexHull(points)
    const start = hull.reduce((best, p, i) => p.y < hull[best].y || (p.y === hull[best].y && p.x < hull[best].x) ? i : best, 0)
    return [...hull.slice(start), ...hull.slice(0, start)]
  }
  const a = prepare(first), b = prepare(second)
  if (!a.length || !b.length) return []
  let i = 0, j = 0
  const points: Point[] = []
  while (i < a.length || j < b.length) {
    const p = a[i % a.length], q = b[j % b.length]
    points.push({ x: p.x + q.x, y: p.y + q.y })
    const nextA = a[(i + 1) % a.length], nextB = b[(j + 1) % b.length]
    const cross = (nextA.x - p.x) * (nextB.y - q.y) - (nextA.y - p.y) * (nextB.x - q.x)
    const advanceA = j === b.length || (i < a.length && cross >= 0)
    const advanceB = i === a.length || (j < b.length && cross <= 0)
    if (advanceA) i++
    if (advanceB) j++
  }
  return convexHull(points)
}
