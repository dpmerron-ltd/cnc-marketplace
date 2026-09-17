import { describe, expect, it } from 'vitest'
import { generateCam } from './generate'
import { arcPoints, contains, cornerOvercuts, distance, offset } from './geometry'
import type { CamDrawing, CamFeature, CamSettings } from './types'

const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 70 }, { x: 0, y: 70 }]
const settings: CamSettings = { thickness: 18, units: 'mm', operations: {} }
const feature: CamFeature = { id: 'p', name: 'Pocket', layer: '0', kind: 'pocket', closed: true, points, depthMm: 6 }
const drawing = (features = [feature]): CamDrawing => ({ features, units: 'mm', errors: [], warnings: [] })

describe('Automatic corner overcuts', () => {
  it.each(['pocket', 'inside'] as const)('relieves all four sharp %s corners by default without a plunge or low rapid', kind => {
    const job = generateCam(drawing([{ ...feature, kind }]), settings)
    expect(job.errors).toEqual([])
    expect(job.gcode).toContain('Automatic corner overcuts: 4')
    const relief = cornerOvercuts(points, [offset(points, -3.175)], 3.175)
    expect(relief.centers).toHaveLength(4)
    for (const [i, center] of relief.centers.entries()) {
      expect(distance(center, points[i])).toBeCloseTo(3.175, 5)
      const translated = { x: center.x + job.shift.x, y: center.y + job.shift.y }
      expect(job.simulation.moves.some(m => distance(m.end, translated) < 0.001 && m.end.z === -(kind === 'pocket' ? 6 : 18.4))).toBe(true)
    }
    expect(job.simulation.moves.filter(m => m.type === 'rapid' && distance(m.start, m.end) > 0.001).every(m => m.start.z === 20 && m.end.z === 20)).toBe(true)
  })

  it('supports reverse winding, explicit disable and leaves curved edges and outer profiles unchanged', () => {
    const reversed = generateCam(drawing([{ ...feature, points: [...points].reverse() }]), settings)
    expect(reversed.errors).toEqual([]); expect(reversed.gcode).toContain('Automatic corner overcuts: 4')
    const disabled = generateCam(drawing(), { ...settings, operations: { p: { cornerOvercuts: false } } })
    expect(disabled.errors).toEqual([]); expect(disabled.gcode).not.toContain('Automatic corner overcuts')
    const circle = arcPoints({ x: 50, y: 50 }, 30, 0, Math.PI * 2).slice(0, -1)
    expect(cornerOvercuts(circle, [offset(circle, -3.175)], 3.175).centers).toEqual([])
    const outer = generateCam(drawing([{ ...feature, kind: 'outside' }]), settings)
    expect(outer.errors).toEqual([]); expect(outer.gcode).not.toContain('Automatic corner overcuts')
    expect(disabled.operations[0].path.every(p => contains(disabled.drawing.features[0].points, p))).toBe(true)
  })

  it('blocks overcuts that break through the surrounding profile or hit a neighboring feature', () => {
    const outer: CamFeature = { ...feature, id: 'outer', name: 'Surrounding part', kind: 'outside', points: [{ x: -0.2, y: -0.2 }, { x: 120, y: -0.2 }, { x: 120, y: 90 }, { x: -0.2, y: 90 }] }
    const job = generateCam(drawing([feature, outer]), settings)
    expect(job.errors.join()).toContain('breaks through'); expect(job.gcode).toBe('')
    expect(generateCam(drawing([feature, outer]), { ...settings, operations: { p: { cornerOvercuts: false } } }).errors).toEqual([])
    const neighbor: CamFeature = { ...feature, id: 'neighbor', name: 'Adjacent pocket', points: [{ x: -30, y: -20 }, { x: -0.2, y: -20 }, { x: -0.2, y: 20 }, { x: -30, y: 20 }] }
    expect(generateCam(drawing([feature, neighbor]), settings).errors.join()).toContain('intersects')
  })
})
