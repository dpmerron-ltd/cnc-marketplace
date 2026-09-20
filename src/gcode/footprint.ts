import ClipperLib from 'clipper-lib'
import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import { emptyBounds, includePoint, rectsOverlap, rotatePointInBounds, rotateVector } from '../models/geometry'
import type { Bounds, Point } from '../models/geometry'
import { arcBounds } from './bounds'
import { createInitialState, getWord, updatePositionFromLine } from './state'

export const footprintScale = 10000
export const toPath = (points: Point[]) => points.map(p => ({ X: Math.round(p.x * footprintScale), Y: Math.round(p.y * footprintScale) }))
export const fromPath = (points: ClipperLib.Path) => points.map(p => ({ x: p.X / footprintScale, y: p.Y / footprintScale }))
export const polygonBounds = (points: Point[]) => points.reduce((bounds, point) => includePoint(bounds, point), emptyBounds())
export const boundsPolygon = (b: Bounds): Point[] => [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }]

export function footprintInterior(points: Point[]) {
  let area = 0, x = 0, y = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], cross = a.x * b.y - b.x * a.y
    area += cross; x += (a.x + b.x) * cross; y += (a.y + b.y) * cross
  }
  const center = Math.abs(area) > 0.000001 ? { x: x / (3 * area), y: y / (3 * area) } : points[0]
  const radius = Math.min(...points.map((a, i) => {
    const b = points[(i + 1) % points.length], length = Math.hypot(b.x - a.x, b.y - a.y)
    return length ? Math.abs((b.x - a.x) * (center.y - a.y) - (b.y - a.y) * (center.x - a.x)) / length : Infinity
  }))
  return { center, radius: Number.isFinite(radius) ? radius : 0 }
}

// A convex envelope keeps holes and concavities reserved as part material.
export function convexHull(points: Point[]): Point[] {
  const sorted = [...new Map(points.map(p => [`${p.x},${p.y}`, p])).values()].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const half = (list: Point[]) => {
    const hull: Point[] = []
    for (const p of list) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop()
      hull.push(p)
    }
    return hull.slice(0, -1)
  }
  return sorted.length < 3 ? sorted : [...half(sorted), ...half([...sorted].reverse())]
}

const cache = new WeakMap<Part, { signature: string; gcode: string; points: Point[]; rotations: Map<number, Bounds> }>()
export function partFootprint(part: Part): Point[] {
  const signature = JSON.stringify([part.originalBounds, part.width, part.height])
  const cached = cache.get(part)
  if (cached?.signature === signature && cached.gcode === part.gcode) return cached.points
  const fallback = boundsPolygon(part.originalBounds)
  let points: Point[] = []
  let state = createInitialState()
  let unsupported = false
  let closed = false
  let chain: Point[] = []
  let seen = new Map<string, number>()
  const pointKey = (p: Point) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`
  // Component startup/footer travel is replaced by safe sheet-level positioning on export.
  for (const line of part.parsed.startLines) state = updatePositionFromLine(state, line)
  const finalCut = part.parsed.bodyLines.findLastIndex(line => ['G01', 'G02', 'G03'].includes(line.effectiveMotion ?? ''))
  for (const line of part.parsed.bodyLines.slice(0, finalCut + 1)) {
    const before = state
    state = updatePositionFromLine(state, line)
    if (line.unsupportedForTransform || state.units !== 'mm' || state.plane !== 'G17') unsupported = true
    const motion = line.effectiveMotion
    const xy = getWord(line, 'X') !== undefined || getWord(line, 'Y') !== undefined
    const arc = motion === 'G02' || motion === 'G03'
    if (motion === 'G00' && xy) { chain = []; seen = new Map() }
    if (arc && (getWord(line, 'R') !== undefined || !xy)) unsupported = true
    if (!motion || !xy || (motion === 'G00' && Math.min(before.position.z, state.position.z) > 0)) continue
    if (!closed && motion !== 'G00') {
      if (!chain.length) { chain.push(before.position); seen.set(pointKey(before.position), 0) }
      const index = seen.get(pointKey(state.position))
      if (index !== undefined && chain.length - index >= 3 && Math.abs(ClipperLib.Clipper.Area(toPath(chain.slice(index)))) > 1) closed = true
      if (arc && Math.hypot(before.position.x - state.position.x, before.position.y - state.position.y) < 0.00001) closed = true
      if (index === undefined) seen.set(pointKey(state.position), chain.length)
      chain.push(state.position)
    }
    if (arc) {
      const center = { x: before.position.x + (getWord(line, 'I') ?? 0), y: before.position.y + (getWord(line, 'J') ?? 0) }
      const radius = Math.hypot(before.position.x - center.x, before.position.y - center.y)
      if (radius < 0.00001 || Math.abs(radius - Math.hypot(state.position.x - center.x, state.position.y - center.y)) > 0.01) unsupported = true
      // Exact arc extents, not inscribed sampled chords, so curved cuts cannot escape the envelope.
      points.push(...boundsPolygon(arcBounds(before.position, state.position, center, motion === 'G02')))
    } else points.push(before.position, state.position)
  }
  points = convexHull(points)
  const b = polygonBounds(points)
  const consistent = (['minX', 'minY', 'maxX', 'maxY'] as const).every(key => Math.abs(b[key] - part.originalBounds[key]) < 0.001)
  if (unsupported || !closed || !consistent || points.length < 3 || Math.abs(ClipperLib.Clipper.Area(toPath(points))) < footprintScale ** 2 * 0.01) {
    // Low XY rapids must not disappear just because cached machining bounds exclude rapids.
    points = boundsPolygon(polygonBounds([...fallback, ...points]))
  }
  cache.set(part, { signature, gcode: part.gcode, points, rotations: new Map() })
  return points
}

export function placementPoint(part: Part, instance: PartInstance, point: Point): Point {
  const local = { x: point.x - part.originalBounds.minX, y: point.y - part.originalBounds.minY }
  if ([0, 90, 180, 270].includes(instance.rotation)) {
    const p = rotatePointInBounds(local, part, instance.rotation)
    return { x: instance.x + p.x, y: instance.y + p.y }
  }
  const rotated = rotateVector(local, instance.rotation)
  const points = partFootprint(part)
  const rotations = cache.get(part)!.rotations
  let bounds = rotations.get(instance.rotation)
  if (!bounds) {
    bounds = polygonBounds(points.map(p => rotateVector({ x: p.x - part.originalBounds.minX, y: p.y - part.originalBounds.minY }, instance.rotation)))
    rotations.set(instance.rotation, bounds)
  }
  return { x: instance.x + (rotated.x - bounds.minX), y: instance.y + (rotated.y - bounds.minY) }
}

export function instanceFootprint(part: Part, instance: PartInstance): Point[] {
  return partFootprint(part).map(point => placementPoint(part, instance, point))
}

const expandedCache = new WeakMap<Point[], Map<number, ClipperLib.Path>>()
export function expandedFootprint(points: Point[], spacing: number): ClipperLib.Path {
  let entries = expandedCache.get(points)
  if (!entries) { entries = new Map(); expandedCache.set(points, entries) }
  const cached = entries.get(spacing)
  if (cached) return cached
  let path = toPath(points)
  if (spacing > 0) {
    const offset = new ClipperLib.ClipperOffset()
    offset.AddPath(path, ClipperLib.JoinType.jtSquare, ClipperLib.EndType.etClosedPolygon)
    const paths: ClipperLib.Paths = []
    offset.Execute(paths, spacing * footprintScale)
    path = paths[0] ?? path
  }
  entries.set(spacing, path)
  return path
}

export function footprintsOverlap(a: Point[], b: Point[], spacing = 0): boolean {
  if (!rectsOverlap(polygonBounds(a), polygonBounds(b), spacing)) return false
  return [[a, b], [b, a]].some(([subject, clip]) => {
    const clipper = new ClipperLib.Clipper()
    clipper.AddPath(expandedFootprint(subject, spacing), ClipperLib.PolyType.ptSubject, true)
    clipper.AddPath(toPath(clip), ClipperLib.PolyType.ptClip, true)
    const intersection: ClipperLib.Paths = []
    clipper.Execute(ClipperLib.ClipType.ctIntersection, intersection, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
    return intersection.some(path => Math.abs(ClipperLib.Clipper.Area(path)) > 1)
  })
}

export function nestingRotations(part: Part, current = 0): number[] {
  const points = partFootprint(part)
  const edges = points.map((p, i) => {
    const q = points[(i + 1) % points.length]
    return { length: Math.hypot(q.x - p.x, q.y - p.y), angle: -Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI }
  }).sort((a, b) => b.length - a.length).slice(0, 12)
  const candidates = edges.filter(edge => edge.length >= edges[0].length * 0.05)
    .flatMap(edge => [edge.angle, edge.angle + 90, edge.angle + 180, edge.angle + 270])
    .map(angle => Math.round(((angle % 360 + 360) % 360) * 1e4) / 1e4 % 360)
  return [...new Set([current, 0, 90, 180, 270, ...candidates])]
}
