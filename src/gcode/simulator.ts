import { emptyBounds, includePoint } from '../models/geometry'
import type { Bounds, Point } from '../models/geometry'
import { parseGCode } from './parser'
import { createInitialState, getWord, updatePositionFromLine } from './state'
import type { MachineState, ParsedLine } from './types'

export type SimulatedMoveType = 'rapid' | 'cut' | 'arc-cw' | 'arc-ccw'

export interface SimulatedMove {
  type: SimulatedMoveType
  lineNumber: number
  raw: string
  start: Point & { z: number }
  end: Point & { z: number }
  center?: Point
  radius?: number
  sweepRadians?: number
  lengthMm: number
  seconds: number
  feedMmPerMinute: number
  points: Point[]
}

export interface GCodeSimulation {
  moves: SimulatedMove[]
  bounds: Bounds
  totalDistanceMm: number
  cuttingDistanceMm: number
  rapidDistanceMm: number
  estimatedSeconds: number
  deepestCutMm: number
  warnings: string[]
  errors: string[]
}

const defaultRapidFeedMmPerMinute = 3000
const twoPi = Math.PI * 2

function normalizeAngle(angle: number): number {
  return ((angle % twoPi) + twoPi) % twoPi
}

function moveType(motion: string): SimulatedMoveType | undefined {
  if (motion === 'G00') return 'rapid'
  if (motion === 'G01') return 'cut'
  if (motion === 'G02') return 'arc-cw'
  if (motion === 'G03') return 'arc-ccw'
  return undefined
}

function point3(state: MachineState): Point & { z: number } {
  return { x: state.position.x, y: state.position.y, z: state.position.z }
}

function linearLength(start: Point & { z: number }, end: Point & { z: number }): number {
  return Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z)
}

function arcFromRadius(start: Point, end: Point, radius: number, clockwise: boolean): { center: Point; sweep: number } | undefined {
  const chordX = end.x - start.x
  const chordY = end.y - start.y
  const chord = Math.hypot(chordX, chordY)
  const absoluteRadius = Math.abs(radius)
  if (chord <= 0.000001 || absoluteRadius < chord / 2) return undefined

  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
  const height = Math.sqrt(Math.max(0, absoluteRadius * absoluteRadius - (chord / 2) * (chord / 2)))
  const normal = { x: -chordY / chord, y: chordX / chord }
  const centers = [
    { x: midpoint.x + normal.x * height, y: midpoint.y + normal.y * height },
    { x: midpoint.x - normal.x * height, y: midpoint.y - normal.y * height },
  ]

  const candidates = centers.map((center) => {
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x)
    const endAngle = Math.atan2(end.y - center.y, end.x - center.x)
    const shortSweep = clockwise ? normalizeAngle(startAngle - endAngle) : normalizeAngle(endAngle - startAngle)
    const sweep = radius >= 0 ? shortSweep : twoPi - shortSweep
    return { center, sweep }
  })

  return candidates.sort((a, b) => Math.abs(a.sweep - (radius >= 0 ? Math.PI : twoPi)) - Math.abs(b.sweep - (radius >= 0 ? Math.PI : twoPi)))[0]
}

function arcGeometry(line: ParsedLine, start: Point & { z: number }, end: Point & { z: number }, clockwise: boolean): { center?: Point; radius?: number; sweep?: number; points: Point[]; xyLength: number; errors: string[] } {
  const i = getWord(line, 'I')
  const j = getWord(line, 'J')
  const r = getWord(line, 'R')
  const errors: string[] = []
  let center: Point | undefined
  let radius: number | undefined
  let sweep: number | undefined

  if (r !== undefined) {
    const geometry = arcFromRadius(start, end, r, clockwise)
    if (!geometry) errors.push(`line ${line.lineNumber + 1}: cannot resolve R arc geometry.`)
    center = geometry?.center
    radius = Math.abs(r)
    sweep = geometry?.sweep
  } else if (i !== undefined || j !== undefined) {
    center = { x: start.x + (i ?? 0), y: start.y + (j ?? 0) }
    radius = Math.hypot(start.x - center.x, start.y - center.y)
    const endRadius = Math.hypot(end.x - center.x, end.y - center.y)
    if (radius <= 0.000001) errors.push(`line ${line.lineNumber + 1}: arc has a zero radius.`)
    if (Math.abs(radius - endRadius) > 0.02) errors.push(`line ${line.lineNumber + 1}: arc radius mismatch ${radius.toFixed(4)} vs ${endRadius.toFixed(4)}.`)
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x)
    const endAngle = Math.atan2(end.y - center.y, end.x - center.x)
    const sameEndpoint = Math.hypot(end.x - start.x, end.y - start.y) < 0.001
    sweep = clockwise ? (sameEndpoint ? twoPi : normalizeAngle(startAngle - endAngle)) : sameEndpoint ? twoPi : normalizeAngle(endAngle - startAngle)
  } else {
    errors.push(`line ${line.lineNumber + 1}: arc move is missing I/J or R geometry.`)
  }

  if (!center || !radius || !sweep) {
    return { center, radius, sweep, points: [start, end], xyLength: Math.hypot(end.x - start.x, end.y - start.y), errors }
  }

  const startAngle = Math.atan2(start.y - center.y, start.x - center.x)
  const steps = Math.max(16, Math.min(220, Math.ceil((radius * sweep) / 3)))
  const points: Point[] = []
  for (let index = 0; index <= steps; index += 1) {
    const progress = index / steps
    const angle = clockwise ? startAngle - sweep * progress : startAngle + sweep * progress
    points.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius })
  }

  return { center, radius, sweep, points, xyLength: radius * sweep, errors }
}

export function simulateGCode(source: string): GCodeSimulation {
  const parsed = parseGCode(source)
  const moves: SimulatedMove[] = []
  const warnings = [...parsed.warnings]
  const errors: string[] = []
  let state: MachineState = createInitialState()
  let feedMmPerMinute = defaultRapidFeedMmPerMinute
  let bounds = emptyBounds()

  for (const line of parsed.lines) {
    const nextFeed = getWord(line, 'F')
    if (nextFeed !== undefined && nextFeed > 0) feedMmPerMinute = nextFeed
    const before = state
    const next = updatePositionFromLine(state, line)
    const motion = line.effectiveMotion ?? next.motion
    const type = motion ? moveType(motion) : undefined
    const hasMotionAxis = ['X', 'Y', 'Z'].some((axis) => getWord(line, axis) !== undefined)
    const hasExplicitG00 = line.words.some((word) => word.letter === 'G' && Math.trunc(word.value) === 0)
    const dropsToZ0Only = hasExplicitG00 && getWord(line, 'Z') === 0 && getWord(line, 'X') === undefined && getWord(line, 'Y') === undefined

    if (type && hasMotionAxis) {
      const start = point3(before)
      const end = point3(next)
      let lengthMm = linearLength(start, end)
      let points: Point[] = [start, end]
      let center: Point | undefined
      let radius: number | undefined
      let sweepRadians: number | undefined

      if (type === 'arc-cw' || type === 'arc-ccw') {
        const arc = arcGeometry(line, start, end, type === 'arc-cw')
        errors.push(...arc.errors)
        center = arc.center
        radius = arc.radius
        sweepRadians = arc.sweep
        points = arc.points
        lengthMm = Math.hypot(arc.xyLength, end.z - start.z)
      }

      if (type === 'rapid' && end.z < -0.0001) warnings.push(`line ${line.lineNumber + 1}: rapid move is below Z0.`)
      for (const point of points) bounds = includePoint(bounds, point)
      const feed = type === 'rapid' && feedMmPerMinute <= 0 ? defaultRapidFeedMmPerMinute : feedMmPerMinute
      moves.push({
        type,
        lineNumber: line.lineNumber + 1,
        raw: line.raw,
        start,
        end,
        center,
        radius,
        sweepRadians,
        lengthMm,
        seconds: feed > 0 ? (lengthMm / feed) * 60 : 0,
        feedMmPerMinute: feed,
        points,
      })
    }

    if (dropsToZ0Only && line.lineNumber < parsed.lines.length - 2) {
      errors.push(`line ${line.lineNumber + 1}: rapid parking move drops to Z0 before the end of the program.`)
    }

    state = next
  }

  const cuttingMoves = moves.filter((move) => move.type !== 'rapid')
  const rapidMoves = moves.filter((move) => move.type === 'rapid')

  return {
    moves,
    bounds,
    totalDistanceMm: moves.reduce((total, move) => total + move.lengthMm, 0),
    cuttingDistanceMm: cuttingMoves.reduce((total, move) => total + move.lengthMm, 0),
    rapidDistanceMm: rapidMoves.reduce((total, move) => total + move.lengthMm, 0),
    estimatedSeconds: moves.reduce((total, move) => total + move.seconds, 0),
    deepestCutMm: Math.abs(Math.min(0, ...moves.filter((move) => move.type !== 'rapid').map((move) => move.end.z))),
    warnings: Array.from(new Set(warnings)),
    errors: Array.from(new Set(errors)),
  }
}
