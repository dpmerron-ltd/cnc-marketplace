import type { Point } from '../models/geometry'
import { convexHull } from '../gcode/footprint'

// Minimum caliper width measures a whole opening independently of its rotation.
export function minimumOpeningWidth(points: Point[]): number {
  if (points.length < 3 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return Infinity
  const hull = convexHull(points)
  if (hull.length < 3) return Infinity
  let width = Infinity, opposite = 1
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length]
    const dx = b.x - a.x, dy = b.y - a.y
    const distance = (j: number) => Math.abs(dx * (hull[j].y - a.y) - dy * (hull[j].x - a.x))
    while (distance((opposite + 1) % hull.length) > distance(opposite) + 1e-9) opposite = (opposite + 1) % hull.length
    width = Math.min(width, distance(opposite) / Math.hypot(dx, dy))
  }
  return width
}

export interface Rectangle {
  center: Point
  width: number
  length: number
  axis: Point
}

// Work in millimetres and follow the actual edges, not the axis-aligned bounding box.
export function rectangleGeometry(input: Point[]): Rectangle | undefined {
  const points = input.filter((p, i) => !i || Math.hypot(p.x - input[i - 1].x, p.y - input[i - 1].y) > 1e-7)
  if (points.length > 1 && Math.hypot(points[0].x - points.at(-1)!.x, points[0].y - points.at(-1)!.y) < 1e-7) points.pop()
  if (points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return
  const corners = points.filter((p, i) => {
    const a = points[(i + points.length - 1) % points.length], b = points[(i + 1) % points.length]
    const ux = p.x - a.x, uy = p.y - a.y, vx = b.x - p.x, vy = b.y - p.y
    return ux * vx + uy * vy <= 0 || Math.abs(ux * vy - uy * vx) > 1e-7 * Math.hypot(ux, uy) * Math.hypot(vx, vy)
  })
  if (corners.length !== 4) return
  const edges = corners.map((p, i) => ({ x: corners[(i + 1) % 4].x - p.x, y: corners[(i + 1) % 4].y - p.y }))
  const lengths = edges.map(e => Math.hypot(e.x, e.y))
  if (lengths.some(length => length < 1e-6)) return
  for (let i = 0; i < 4; i++) {
    const a = edges[i], b = edges[(i + 1) % 4]
    if (Math.abs(a.x * b.x + a.y * b.y) > 1e-7 * lengths[i] * lengths[(i + 1) % 4]) return
  }
  if (Math.hypot(corners[0].x + corners[2].x - corners[1].x - corners[3].x, corners[0].y + corners[2].y - corners[1].y - corners[3].y) > 1e-6) return
  const long = lengths[0] >= lengths[1] ? 0 : 1
  return { center: { x: (corners[0].x + corners[2].x) / 2, y: (corners[0].y + corners[2].y) / 2 }, width: Math.min(lengths[0], lengths[1]), length: lengths[long], axis: { x: edges[long].x / lengths[long], y: edges[long].y / lengths[long] } }
}

export function cutterWidthGeometry(rectangle: Rectangle, diameter: number, overcuts: boolean) {
  const { center, axis } = rectangle, normal = { x: -axis.y, y: axis.x }
  const radius = diameter / 2, length = Math.max(rectangle.length, diameter)
  const at = (along: number, across: number): Point => ({ x: center.x + along * axis.x + across * normal.x, y: center.y + along * axis.y + across * normal.y })
  const outline = [at(-length / 2, -radius), at(length / 2, -radius), at(length / 2, radius), at(-length / 2, radius)]
  const travel = (length - diameter) / 2
  const a = at(-travel, 0), b = at(travel, 0)
  const inset = radius - radius / Math.SQRT2
  const centers = overcuts ? [at(-travel - inset, -inset), at(-travel - inset, inset), at(travel + inset, -inset), at(travel + inset, inset)] : []
  const path = [a, ...centers.slice(0, 2).flatMap(p => [p, a]), b, ...centers.slice(2).flatMap(p => [p, b])].filter((p, i, points) => !i || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 1e-7)
  if (path.length > 1 && Math.hypot(path[0].x - path.at(-1)!.x, path[0].y - path.at(-1)!.y) < 1e-7) path.pop()
  return { outline, path, centers, pointHole: travel < 1e-6 }
}
