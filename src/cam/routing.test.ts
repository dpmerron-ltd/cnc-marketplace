import { describe, expect, it } from 'vitest'
import { profileEntry, routeOperations, type RouteOperation } from './routing'
import { area, distance, pathMetric } from './geometry'
import { generateCam, materialPreset } from './generate'
import type { CamDrawing, CamFeature, CamSettings } from './types'
import { materialProfiles } from './materialProfiles'

const point = (x: number, y = 0) => ({ x, y })
const fixed = (id: string, x: number, rank = 0, predecessors: string[] = []): RouteOperation => ({ id, rank, predecessors: new Set(predecessors), entry: () => ({ point: point(x) }) })
const rectangle = (id: string, x: number, y: number, width: number, height: number, kind: CamFeature['kind'] = 'outside'): CamFeature => ({ id, name: id, layer: kind, kind, closed: true, points: [point(x, y), point(x + width, y), point(x + width, y + height), point(x, y + height)] })
const drill = (id: string, x: number, y: number): CamFeature => ({ id, name: id, layer: 'DRILL', kind: 'drill', closed: false, points: [point(x, y)] })
const drawing = (features: CamFeature[]): CamDrawing => ({ features, errors: [], warnings: [], units: 'mm' })

describe('Travel routing', () => {
  it('visits nearby holes first without crossing operation groups', () => {
    const result = routeOperations([fixed('far', 100), fixed('near', 10), fixed('middle', 50), fixed('profile', 0, 3)], point(0))
    // Both hole routes finish with a profile at zero; never choose a longer full route.
    expect(result.travel).toBeLessThanOrEqual(result.originalTravel)
    expect(result.steps.at(-1)?.operation.id).toBe('profile')
    const holes = routeOperations([fixed('far', 100), fixed('near', 10), fixed('middle', 50)], point(0))
    expect(holes.steps.map(step => step.operation.id)).toEqual(['near', 'middle', 'far'])
    expect(holes.travel).toBe(100)
    expect(holes.originalTravel).toBe(230)
  })
  it('preserves inner-before-enclosing cuts even when the enclosing entry is nearer', () => {
    const result = routeOperations([fixed('child', 100, 2), fixed('parent', 1, 2, ['child'])], point(0))
    expect(result.steps.map(step => step.operation.id)).toEqual(['child', 'parent'])
  })
  it('routes from the actual exit rather than the entry of a pocket', () => {
    const pocket = { ...fixed('pocket', 10, 1), entry: () => ({ point: point(10), exit: point(100) }) }
    const result = routeOperations([pocket, fixed('left', 20, 2), fixed('right', 95, 2)], point(0))
    expect(result.steps.map(step => step.operation.id)).toEqual(['pocket', 'right', 'left'])
    expect(result.travel).toBe(90)
  })
  it('is deterministic, bounded and never worse than the existing route', () => {
    let seed = 7
    const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32 }
    for (let fixture = 0; fixture < 30; fixture++) {
      const operations = Array.from({ length: 50 }, (_, i) => {
        const start = point(random() * 1000, random() * 1000), exit = point(random() * 1000, random() * 1000)
        return { ...fixed(String(i), 0, Math.floor(i / 15)), entry: () => ({ point: start, exit }) }
      })
      const result = routeOperations(operations, point(0))
      expect(result.travel).toBeLessThanOrEqual(result.originalTravel + 1e-6)
      expect(result.steps).toHaveLength(operations.length)
      expect(new Set(result.steps.map(step => step.operation.id)).size).toBe(operations.length)
      expect(routeOperations(operations, point(0))).toEqual(result)
    }
  })
})

describe('Profile entries', () => {
  const path = rectangle('panel', 0, 0, 400, 300).points
  const tabs: Array<[number, number]> = [[100, 120], [500, 520], [800, 820], [1200, 1220]]
  it('chooses a closer tab-free entry with forward ramp room and corner clearance', () => {
    const choose = profileEntry(path, tabs, 3.175, 60), from = point(30, -10)
    const baseline = choose(from, false), entry = choose(from, true)
    expect(distance(from, entry.point)).toBeLessThan(distance(from, baseline.point))
    expect(entry.point.x).toBeCloseTo(30, 8)
    expect(entry.point.y).toBe(0)
    expect(entry.start).toBeCloseTo(30, 8)
    expect(100 - entry.start!).toBeGreaterThan(60)
    expect(path).toEqual(rectangle('panel', 0, 0, 400, 300).points)
  })
  it('keeps every chosen start away from tabs, including the wrap-around gap', () => {
    const choose = profileEntry(path, tabs, 3.175, 60), metric = pathMetric(path)
    for (const from of [point(0, 0), point(800, 800), point(-10, 40), point(110, -10)]) {
      const entry = choose(from, true), start = entry.start!
      expect(tabs.some(([a, b]) => start >= a && start <= b)).toBe(false)
      const nextTab = tabs.find(([a]) => a > start)?.[0] ?? tabs[0][0] + metric.length
      expect(nextTab - start).toBeGreaterThanOrEqual(60)
      expect(distance(entry.point, metric.at(start))).toBeLessThan(1e-6)
    }
  })
  it('uses the existing entry when no alternative straight span fits', () => {
    const choose = profileEntry(path, tabs, 1000, 60)
    expect(choose(point(0), true)).toEqual(choose(point(0), false))
    expect(() => profileEntry([point(0)], [], 3.175, 60)).toThrow('too short')
  })
})

describe('Routed machining output', () => {
  const source = drawing([rectangle('outer', 0, 0, 600, 300), drill('far', 550, 30), drill('near', 30, 30), drill('middle', 300, 30)])
  it.each(materialProfiles)('preserves machining rules for $label', profile => {
    const settings: CamSettings = { thickness: profile.thickness, profilePasses: profile.thickness === 12 ? profile.profilePasses : undefined, drillDepthMm: profile.drillDepthMm, rampProfile: profile.rampProfile, units: 'mm', operations: {} }
    const job = generateCam(source, settings)
    expect(job.errors).toEqual([])
    expect(job.operations.map(op => op.featureId)).toEqual(['near', 'middle', 'far', 'outer'])
    const preset = materialPreset(settings.thickness, settings.profilePasses, settings.drillDepthMm, settings.rampProfile)
    expect(job.operations.filter(op => op.kind === 'drill').every(op => op.depthMm === preset.drill)).toBe(true)
    const outer = job.operations.at(-1)!
    expect(outer.depthMm).toBe(preset.depth)
    expect(outer.tabs).toHaveLength(4)
    expect(area(outer.path)).toBeGreaterThan(0)
    expect(job.simulation.deepestCutMm).toBe(preset.depth)
    for (const move of job.simulation.moves.filter(move => move.type === 'rapid' && distance(move.start, move.end) > 0.001)) {
      expect(move.start.z).toBe(20); expect(move.end.z).toBe(20)
    }
    const lines = job.gcode.split('\n')
    for (const op of job.operations) {
      expect(lines[op.firstLine - 1]).toContain(op.name)
      expect(lines[op.lastLine - 1]).toBe('G00 Z20')
    }
    expect(generateCam(source, settings).gcode).toBe(job.gcode)
  })
  it('keeps nested inside operations ahead of their enclosing door and outer profile', () => {
    const job = generateCam(drawing([rectangle('outer', 0, 0, 600, 500), rectangle('parent', 20, 20, 550, 450, 'inside'), rectangle('child', 400, 300, 100, 100, 'inside')]), { thickness: 12, units: 'mm', operations: {} })
    expect(job.errors).toEqual([])
    expect(job.operations.map(op => op.featureId)).toEqual(['child', 'parent', 'outer'])
  })
  it('reports invalid drills instead of crashing the routing planner', () => {
    const job = generateCam(drawing([{ ...drill('invalid', 0, 0), points: [] }]), { thickness: 12, units: 'mm', operations: {} })
    expect(job.gcode).toBe('')
    expect(job.errors.join()).toContain('Drilling requires')
  })
})
