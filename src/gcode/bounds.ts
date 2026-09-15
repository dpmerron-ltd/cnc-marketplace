import { emptyBounds, includePoint, isFiniteBounds } from '../models/geometry'
import type { Bounds } from '../models/geometry'
import type { ParsedProgram, ToolpathSegment } from './types'
import { createInitialState, getWord, updatePositionFromLine } from './state'

function lineBounds(start: { x: number; y: number }, end: { x: number; y: number }): Bounds {
  return includePoint(includePoint(emptyBounds(), start), end)
}

function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2
  return ((angle % twoPi) + twoPi) % twoPi
}

function angleOnSweep(angle: number, start: number, end: number, clockwise: boolean): boolean {
  const a = normalizeAngle(angle)
  const s = normalizeAngle(start)
  const e = normalizeAngle(end)

  if (clockwise) {
    const sweep = normalizeAngle(s - e)
    return normalizeAngle(s - a) <= sweep + 1e-9
  }

  const sweep = normalizeAngle(e - s)
  return normalizeAngle(a - s) <= sweep + 1e-9
}

export function arcBounds(start: { x: number; y: number }, end: { x: number; y: number }, center: { x: number; y: number }, clockwise: boolean): Bounds {
  const startRadius = Math.hypot(start.x - center.x, start.y - center.y)
  const endRadius = Math.hypot(end.x - center.x, end.y - center.y)
  if (Math.abs(startRadius - endRadius) > 0.01) return lineBounds(start, end)

  const radius = startRadius
  if (Math.hypot(end.x - start.x, end.y - start.y) < 0.000001) {
    return { minX: center.x - radius, minY: center.y - radius, maxX: center.x + radius, maxY: center.y + radius }
  }
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x)
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x)
  let bounds = lineBounds(start, end)
  for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    if (!angleOnSweep(angle, startAngle, endAngle, clockwise)) continue
    bounds = includePoint(bounds, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius })
  }
  return bounds
}

export function getProgramSegments(program: ParsedProgram): ToolpathSegment[] {
  let state = createInitialState()
  const segments: ToolpathSegment[] = []

  for (const line of program.lines) {
    const before = state
    const next = updatePositionFromLine(state, line)
    const motion = line.effectiveMotion ?? next.motion
    const hasXy = getWord(line, 'X') !== undefined || getWord(line, 'Y') !== undefined
    const start = { x: before.position.x, y: before.position.y }
    const end = { x: next.position.x, y: next.position.y }

    if (motion && hasXy) {
      let bounds = lineBounds(start, end)
      let center: { x: number; y: number } | undefined
      if (motion === 'G02' || motion === 'G03') {
        center = { x: start.x + (getWord(line, 'I') ?? 0), y: start.y + (getWord(line, 'J') ?? 0) }
        bounds = arcBounds(start, end, center, motion === 'G02')
      }
      segments.push({ type: motion === 'G00' ? 'rapid' : motion === 'G01' ? 'cut' : motion === 'G02' ? 'arc-cw' : 'arc-ccw', start, end, center, bounds, lineNumber: line.lineNumber })
    }

    state = next
  }

  return segments
}

export function calculateMachiningBounds(program: ParsedProgram): Bounds {
  const segments = getProgramSegments(program)
  const machiningSegments = segments.filter((segment) => segment.type !== 'rapid')
  const source = machiningSegments.length > 0 ? machiningSegments : segments
  let bounds = emptyBounds()

  for (const segment of source) {
    bounds = includePoint(bounds, { x: segment.bounds.minX, y: segment.bounds.minY })
    bounds = includePoint(bounds, { x: segment.bounds.maxX, y: segment.bounds.maxY })
  }

  return isFiniteBounds(bounds) ? bounds : { minX: 0, minY: 0, maxX: 0, maxY: 0 }
}
