import { describe, expect, it } from 'vitest'
import { generateCam } from './generate'
import { readDxf } from './dxf'
import { contains, distance, pocketPaths } from './geometry'
import type { Point } from '../models/geometry'
import type { CamDrawing, CamSettings } from './types'

const settings: CamSettings = { thickness: 18, units: 'mm', operations: { p: { cornerOvercuts: false } } }
const polygon = (coords: number[][]): Point[] => coords.map(([x, y]) => ({ x, y }))
const rectangle = polygon([[0, 0], [100, 0], [100, 70], [0, 70]])
const concave = polygon([[0, 0], [100, 0], [100, 70], [70, 70], [70, 25], [30, 25], [30, 70], [0, 70]])
const split = polygon([[0, 0], [30, 0], [30, 14], [70, 14], [70, 0], [100, 0], [100, 30], [70, 30], [70, 18], [30, 18], [30, 30], [0, 30]])
const drawing = (points: Point[], depthMm?: number): CamDrawing => ({ units: 'mm', errors: [], warnings: [], features: [{ id: 'p', name: 'Polygon pocket', layer: '0', points, closed: true, kind: 'pocket', depthMm }] })
const segmentDistance = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x, dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy })
}
const boundaryDistance = (p: Point, points: Point[]) => Math.min(...points.map((a, i) => segmentDistance(p, a, points[(i + 1) % points.length])))

describe('Non-circular pocket clearing', () => {
  it.each([['rectangle', rectangle], ['concave', concave], ['split region', split], ['reverse winding', [...concave].reverse()]] as const)('clears the reachable interior of a %s without crossing its boundary', (_, points) => {
    const job = generateCam(drawing([...points], 4), settings)
    expect(job.errors).toEqual([])
    const boundary = job.drawing.features[0].points
    const moves = job.simulation.moves.filter(m => m.type !== 'rapid' && m.end.z < 0 && distance(m.start, m.end) > 0)
    expect(moves.length).toBeGreaterThan(5)
    for (const move of moves) {
      const count = Math.ceil(distance(move.start, move.end))
      for (let i = 0; i <= count; i++) {
        const t = i / count, p = { x: move.start.x + (move.end.x - move.start.x) * t, y: move.start.y + (move.end.y - move.start.y) * t }
        expect(contains(boundary, p)).toBe(true)
        expect(boundaryDistance(p, boundary)).toBeGreaterThanOrEqual(3.175 - 0.025)
      }
    }
    const floor = moves.filter(m => m.start.z === -4 && m.end.z === -4)
    for (let x = 0.7; x < 100; x += 3) for (let y = 0.7; y < 70; y += 3) {
      const p = { x: x + job.shift.x, y: y + job.shift.y }
      if (!contains(boundary, p) || boundaryDistance(p, boundary) < 3.175) continue
      expect(Math.min(...floor.map(m => segmentDistance(p, m.start, m.end)))).toBeLessThanOrEqual(3.175 + 0.025)
    }
    expect(job.operations[0].tabs).toEqual([])
    expect(job.gcode).not.toMatch(/reach check/i)
  })

  it.each([12, 18] as const)('retains %s mm presets, ramp limits and Z20 linking moves', thickness => {
    const depth = thickness === 18 ? 12 : 6
    const job = generateCam(drawing(concave, depth), { ...settings, thickness })
    expect(job.errors).toEqual([])
    expect(job.simulation.deepestCutMm).toBe(depth)
    expect(job.gcode).toContain('S18000 M03')
    expect(job.gcode).toContain(`(Pass depth ${thickness === 18 ? 9.2 : 6} mm)`)
    for (const move of job.simulation.moves) {
      const travel = distance(move.start, move.end)
      if (move.type === 'rapid' && travel > 0.001) {
        expect(move.start.z).toBe(20); expect(move.end.z).toBe(20)
      }
      if (move.type !== 'rapid' && move.end.z < move.start.z && travel > 0.001) {
        expect((move.start.z - move.end.z) / travel).toBeLessThanOrEqual(Math.tan(3 * Math.PI / 180) + 0.001)
        expect(move.feedMmPerMinute).toBe(600)
      }
      if (move.type !== 'rapid' && travel < 0.001 && move.end.z < 0) expect(move.end.z).toBe(-9.2)
    }
  })

  it('retains depth hints for explicitly selected polygon pockets and supports curved boundaries', () => {
    const source = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', 0, 'LWPOLYLINE', 8, 'POCKET_DEPTH6', 90, 2, 70, 1, 10, 0, 20, 0, 42, 1, 10, 70, 20, 0, 42, 1, 0, 'ENDSEC', 0, 'EOF', ''].join('\n')
    const parsed = readDxf(source)
    expect(parsed.features[0]).toMatchObject({ kind: 'inside', depthMm: 6 })
    expect(parsed.features[0].circle).toBeUndefined()
    const job = generateCam(parsed, { ...settings, operations: { f0: { kind: 'pocket' } } })
    expect(job.errors).toEqual([])
    expect(job.simulation.deepestCutMm).toBe(6)
  })

  it('blocks collapsed, self-intersecting and open pockets', () => {
    for (const points of [polygon([[0, 0], [6, 0], [6, 20], [0, 20]]), polygon([[0, 0], [100, 100], [0, 100], [100, 0]])]) {
      const job = generateCam(drawing(points, 6), settings)
      expect(job.gcode).toBe(''); expect(job.errors.length).toBeGreaterThan(0)
    }
    const open = drawing(rectangle); open.features[0].closed = false
    expect(generateCam(open, settings).errors.join()).toContain('open contour')
    expect(generateCam(drawing(rectangle, 99), settings).errors.join()).toContain('blind pocket depth')
  })

  it('does not silently clear a nested island, but allows a surrounding part profile', () => {
    const source = drawing(rectangle, 6)
    source.features.push({ ...source.features[0], id: 'island', name: 'Island', kind: 'outside', points: polygon([[20, 20], [40, 20], [40, 40], [20, 40]]) })
    expect(generateCam(source, settings).errors.join()).toContain('Island pockets are not supported')
    expect(generateCam(source, { ...settings, operations: { island: { kind: 'ignore' } } }).errors).toEqual([])
    source.features[1].points = polygon([[-20, -20], [120, -20], [120, 90], [-20, 90]])
    expect(generateCam(source, settings).errors).toEqual([])
  })

  it('retains both disconnected cutter regions and bounds geometry work', () => {
    const paths = pocketPaths(split, 3.175, 2.54)
    expect(paths.some(p => p.every(v => v.x < 40))).toBe(true)
    expect(paths.some(p => p.every(v => v.x > 60))).toBe(true)
    expect(() => pocketPaths(rectangle, 3.175, 0.001)).toThrow('limit')
  })
  it('requires an explicit blind depth and never converts a 12 mm depth to a through-hole', () => {
    expect(generateCam(drawing(rectangle), settings).gcode).toBe('')
    const source = drawing(rectangle, 12)
    const thick = generateCam(source, settings)
    expect(thick.errors).toEqual([]); expect(thick.operations[0].kind).toBe('pocket')
    expect(thick.simulation.deepestCutMm).toBe(12)
    const thin = generateCam(source, { ...settings, thickness: 12 })
    expect(thin.gcode).toBe(''); expect(thin.errors.join()).toContain('less than 12 mm')
  })
})
