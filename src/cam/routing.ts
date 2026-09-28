import type { Point } from '../models/geometry'
import { distance, pathMetric } from './geometry'

export interface RouteEntry { point: Point; exit?: Point; start?: number }
export interface RouteOperation {
  id: string
  rank: number
  predecessors: Set<string>
  entry: (from: Point, optimise: boolean) => RouteEntry
}

// Compare against the existing order as nearest-neighbour alone can make a route longer.
export function routeOperations<T extends RouteOperation>(operations: T[], origin: Point) {
  const plan = (nearest: boolean, optimise: boolean) => {
    const pending = [...operations], steps: Array<{ operation: T; entry: RouteEntry }> = []
    let cursor = origin, travel = 0
    while (pending.length) {
      const rank = Math.min(...pending.map(op => op.rank))
      const ids = new Set(pending.map(op => op.id))
      const ready = pending.filter(op => op.rank === rank && ![...op.predecessors].some(id => ids.has(id)))
      if (!ready.length) throw new Error('Machining operation dependencies contain a cycle.')
      let operation = ready[0], entry = operation.entry(cursor, optimise)
      if (nearest) for (const candidate of ready.slice(1)) {
        const next = candidate.entry(cursor, optimise)
        if (distance(cursor, next.point) < distance(cursor, entry.point) - 1e-6) { operation = candidate; entry = next }
      }
      travel += distance(cursor, entry.point)
      cursor = entry.exit ?? entry.point
      steps.push({ operation, entry })
      pending.splice(pending.indexOf(operation), 1)
    }
    return { steps, travel }
  }
  const baseline = plan(false, false)
  let best = baseline
  for (const candidate of [plan(false, true), plan(true, true)]) if (candidate.travel < best.travel - 1e-6) best = candidate
  return { ...best, originalTravel: baseline.travel }
}

export function profileEntry(path: Point[], tabs: Array<[number, number]>, cornerMargin: number, rampRun: number) {
  const metric = pathMetric(path), length = metric.length
  if (!Number.isFinite(length) || length < 0.1) throw new Error('Profile is too short for a ramp.')
  const gaps = tabs.length ? tabs.map((tab, i) => ({
    start: tab[1], end: tabs[(i + 1) % tabs.length][0] + (i === tabs.length - 1 ? length : 0),
  })) : [{ start: 0, end: length }]
  const longest = [...gaps].sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]
  const legacy = tabs.length ? ((longest.start + longest.end) / 2) % length : 0
  // Never require more reversals than the previous longest-gap entry.
  const required = Math.min(rampRun + 0.05, (longest.end - longest.start) / 2)
  const spans: Array<{ from: number; to: number; a: Point; b: Point }> = []
  for (let i = 0; i < path.length; i++) {
    const a = metric.cumulative[i] + cornerMargin, b = metric.cumulative[i + 1] - cornerMargin
    if (b <= a + 1e-6) continue
    if (!tabs.length) spans.push({ from: a, to: b, a: metric.at(a), b: metric.at(b) })
    else for (const gap of gaps) for (const wrap of [0, length]) {
      // The last tab also needs room to ramp back down before the contour closes at this entry.
      const from = Math.max(a + wrap, gap.start + required), to = Math.min(b + wrap, gap.end - required)
      if (to > from + 1e-6) spans.push({ from, to, a: metric.at(from % length), b: metric.at(to % length) })
    }
  }
  return (from: Point, optimise: boolean): RouteEntry => {
    let start = legacy, point = metric.at(start)
    if (optimise) for (const span of spans) {
      const dx = span.b.x - span.a.x, dy = span.b.y - span.a.y
      const t = Math.max(0, Math.min(1, ((from.x - span.a.x) * dx + (from.y - span.a.y) * dy) / (dx * dx + dy * dy)))
      const candidate = { x: span.a.x + t * dx, y: span.a.y + t * dy }
      if (distance(from, candidate) < distance(from, point) - 1e-6) { point = candidate; start = (span.from + t * (span.to - span.from)) % length }
    }
    return { point, start }
  }
}
