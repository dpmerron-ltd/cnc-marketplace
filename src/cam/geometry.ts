import ClipperLib from 'clipper-lib'
import type { Point } from '../models/geometry'

export const tolerance = 0.02
export const scale = 10000
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
export const toClipper = (points: Point[]) => points.map(p => ({ X: Math.round(p.x * scale), Y: Math.round(p.y * scale) }))
export const fromClipper = (points: ClipperLib.Path) => points.map(p => ({ x: p.X / scale, y: p.Y / scale }))
export const area = (points: Point[]) => ClipperLib.Clipper.Area(toClipper(points)) / scale ** 2
export const contains = (points: Point[], point: Point) => ClipperLib.Clipper.PointInPolygon(toClipper([point])[0], toClipper(points)) !== 0

export function offset(points: Point[], amount: number): Point[] {
  const path = toClipper(points)
  if (!ClipperLib.Clipper.Orientation(path)) path.reverse()
  const simple = ClipperLib.Clipper.SimplifyPolygon(path, ClipperLib.PolyFillType.pftNonZero)
  if (simple.length !== 1 || Math.abs(ClipperLib.Clipper.Area(path) - ClipperLib.Clipper.Area(simple[0])) > scale ** 2 * 0.01) throw new Error('Self-intersecting or ambiguous contour.')
  const co = new ClipperLib.ClipperOffset(2, tolerance * scale)
  co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
  const paths: ClipperLib.Paths = []
  co.Execute(paths, amount * scale)
  if (paths.length !== 1 || Math.abs(ClipperLib.Clipper.Area(paths[0])) < scale ** 2) throw new Error('Cutter does not fit, or compensation splits the contour.')
  return fromClipper(paths[0])
}

export function intersectionArea(a: Point[], b: Point[]): number {
  const clip = new ClipperLib.Clipper()
  clip.AddPath(toClipper(a), ClipperLib.PolyType.ptSubject, true)
  clip.AddPath(toClipper(b), ClipperLib.PolyType.ptClip, true)
  const solution: ClipperLib.Paths = []
  clip.Execute(ClipperLib.ClipType.ctIntersection, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return solution.reduce((sum, p) => sum + Math.abs(ClipperLib.Clipper.Area(p)) / scale ** 2, 0)
}

export function arcPoints(center: Point, radius: number, start: number, sweep: number): Point[] {
  if (!Number.isFinite(radius) || radius <= 0 || radius > 10000) throw new Error('Invalid curve radius.')
  const angle = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / radius)))
  const count = Math.max(2, Math.ceil(Math.abs(sweep) / Math.min(Math.PI / 12, angle)))
  if (count > 4000) throw new Error('Curve exceeds the geometry limit.')
  return Array.from({ length: count + 1 }, (_, i) => ({ x: center.x + radius * Math.cos(start + sweep * i / count), y: center.y + radius * Math.sin(start + sweep * i / count) }))
}

export function pathMetric(points: Point[]) {
  const cumulative = [0]
  for (let i = 0; i < points.length; i++) cumulative.push(cumulative[i] + distance(points[i], points[(i + 1) % points.length]))
  const length = cumulative.at(-1)!
  const at = (position: number): Point => {
    const s = Math.min(length, Math.max(0, position))
    const index = Math.min(points.length - 1, Math.max(0, cumulative.findIndex(v => v >= s + 1e-7) - 1))
    if (s >= length - 1e-7) return points[0]
    const t = (s - cumulative[index]) / (cumulative[index + 1] - cumulative[index])
    const a = points[index], b = points[(index + 1) % points.length]
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  }
  const between = (start: number, end: number) => {
    const positions = cumulative.filter(v => v > Math.min(start, end) + 1e-7 && v < Math.max(start, end) - 1e-7)
    if (end < start) positions.reverse()
    return [...positions, end].map(s => ({ s, point: at(s) }))
  }
  return { length, cumulative, at, between }
}
