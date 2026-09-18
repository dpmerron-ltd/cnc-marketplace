import { describe, expect, it } from 'vitest'
import { readDxf } from './dxf'
import { generateCam, materialPreset } from './generate'
import { area, contains, distance, offset } from './geometry'
import type { CamDrawing, CamFeature, CamSettings } from './types'
import { defaultTabCount, requiresHoldingTabs } from './types'
import { createPartFromGCode } from '../gcode/importPart'
import { exportCombinedGCode } from '../gcode/exporter'
import { parseGCode } from '../gcode/parser'
import { simulateGCode } from '../gcode/simulator'

function dxf(entities: Array<Array<string | number>>, units = 4) {
  return ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', units, '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...entities.flat(), '0', 'ENDSEC', '0', 'EOF', ''].join('\n')
}
const rectangle = (x = 0, y = 0, width = 300, height = 200, layer = 'CUT_OUTER') => [0, 'LWPOLYLINE', 8, layer, 90, 4, 70, 1, 10, x, 20, y, 10, x + width, 20, y, 10, x + width, 20, y + height, 10, x, 20, y + height]
const circle = (x: number, y: number, radius: number, layer = 'DRILL') => [0, 'CIRCLE', 8, layer, 10, x, 20, y, 40, radius]
const settings: CamSettings = { thickness: 18, units: 'auto', operations: {} }
const source = () => dxf([rectangle(), rectangle(70, 60, 150, 90, 'CUT_DOOR_RELEASE'), circle(20, 20, 3.175), circle(100, 100, 17.5, 'POCKET_D35_DEPTH12')])
const result = (thickness: CamSettings['thickness'] = 18) => generateCam(readDxf(source()), { ...settings, thickness, operations: thickness === 12 ? { f3: { kind: 'ignore' } } : {} })

describe('DXF geometry', () => {
  it('recognizes layer operations, millimetres and circular pocket depth', () => {
    const parsed = readDxf(source())
    expect(parsed.errors).toEqual([])
    expect(parsed.units).toBe('mm')
    expect(parsed.features.map(f => f.kind)).toEqual(['outside', 'inside', 'drill', 'pocket'])
    expect(parsed.features[3].depthMm).toBe(12)
  })
  it('joins unordered line segments and arcs into closed contours', () => {
    const parsed = readDxf(dxf([
      [0, 'LINE', 10, 0, 20, 0, 11, 100, 21, 0],
      [0, 'ARC', 10, 100, 20, 50, 40, 50, 50, 270, 51, 90],
      [0, 'LINE', 10, 0, 20, 100, 11, 100, 21, 100],
      [0, 'LINE', 10, 0, 20, 0, 11, 0, 21, 100],
    ]))
    expect(parsed.errors).toEqual([])
    expect(parsed.features).toHaveLength(1)
    expect(parsed.features[0].closed).toBe(true)
    expect(Math.abs(area(parsed.features[0].points))).toBeCloseTo(10000 + Math.PI * 50 ** 2 / 2, -1)
  })
  it('preserves polyline bulges and detects containment without layer names', () => {
    const parsed = readDxf(dxf([rectangle(0, 0, 300, 200, '0'), rectangle(50, 50, 100, 70, '0'), [0, 'LWPOLYLINE', 90, 2, 70, 1, 10, 400, 20, 50, 42, 1, 10, 500, 20, 50, 42, 1]]))
    expect(parsed.features.map(f => f.kind)).toEqual(['outside', 'inside', 'outside'])
    expect(Math.abs(area(parsed.features[2].points))).toBeCloseTo(Math.PI * 50 ** 2, -1)
  })
  it('blocks unsupported, non-planar and open geometry without silently dropping it', () => {
    expect(readDxf(dxf([[0, 'INSERT', 2, 'block', 10, 0, 20, 0]])).errors.join()).toContain('Unsupported')
    expect(readDxf(dxf([[0, 'LINE', 10, 0, 20, 0, 30, 1, 11, 100, 21, 0]])).errors.join()).toContain('flat XY')
    const open = readDxf(dxf([[0, 'LINE', 10, 0, 20, 0, 11, 100, 21, 0]]))
    expect(generateCam(open, settings).gcode).toBe('')
    expect(generateCam(open, settings).errors.join()).toContain('Assign an operation')
    expect(() => readDxf('x'.repeat(2000001))).toThrow('2 MB')
  })
  it('offsets either winding and rejects collapsed or self-intersecting contours', () => {
    const points = readDxf(dxf([rectangle()])).features[0].points
    expect(Math.abs(area(offset(points, -3.175)))).toBeCloseTo(Math.abs(area(offset([...points].reverse(), -3.175))), 2)
    expect(() => offset([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }], -3.175)).toThrow()
    expect(() => offset([{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 }], 3.175)).toThrow()
  })
})

describe('CNC generation', () => {
  it('adds a two-pass 12 mm preset without changing drilling, clearance or holding tabs', () => {
    const job = generateCam(readDxf(source()), { ...settings, thickness: 12, profilePasses: 2, operations: { f3: { kind: 'ignore' } } })
    expect(materialPreset(12, 2)).toEqual({ depth: 12.2, passes: [6.1, 12.2], drill: 4.5 })
    expect(job.errors).toEqual([])
    expect(job.simulation.warnings).toEqual([])
    expect(job.simulation.deepestCutMm).toBe(12.2)
    expect(job.operations.find(o => o.kind === 'drill')?.depthMm).toBe(4.5)
    for (const depth of [2, 4, 4.5]) expect(job.gcode).toContain(`G01 Z-${depth} F600\nG00 Z${depth === 4.5 ? 20 : 0.5}`)
    for (const op of job.operations.filter(o => ['inside', 'outside'].includes(o.kind))) {
      const code = job.gcode.split('\n').slice(op.firstLine - 1, op.lastLine).join('\n')
      expect(code.match(/\(Pass depth [\d.]+ mm\)/g)).toEqual(['(Pass depth 6.1 mm)', '(Pass depth 12.2 mm)'])
      expect(op.tabs).toHaveLength(4)
      const moves = job.simulation.moves.filter(m => m.lineNumber >= op.firstLine && m.lineNumber <= op.lastLine)
      for (const m of moves.filter(m => m.end.z < m.start.z - 0.001 && distance(m.start, m.end) > 0.01)) {
        expect(Math.atan2(m.start.z - m.end.z, distance(m.start, m.end)) * 180 / Math.PI).toBeCloseTo(3, 1)
      }
      for (const tab of op.tabs) {
        const midpoint = { x: (tab.start.x + tab.end.x) / 2, y: (tab.start.y + tab.end.y) / 2 }
        const crossing = moves.filter(m => distance(m.start, m.end) > 0.01 && Math.abs(distance(m.start, midpoint) + distance(midpoint, m.end) - distance(m.start, m.end)) < 0.001)
        expect(crossing.length).toBeGreaterThan(0)
        expect(crossing.every(m => Math.min(m.start.z, m.end.z) >= -6.201)).toBe(true)
      }
    }
    for (const m of job.simulation.moves.filter(m => m.type === 'rapid' && distance(m.start, m.end) > 0.001)) {
      expect(m.start.z).toBe(20); expect(m.end.z).toBe(20)
    }
    expect(generateCam(readDxf(source()), { ...settings, thickness: 12, profilePasses: 1, operations: { f3: { kind: 'ignore' } } }).gcode).toBe(result(12).gcode)
  })
  it.each([{ thickness: 18, profilePasses: 2 }, { thickness: 15, profilePasses: 1 }, { thickness: 12, profilePasses: 3 }])('rejects unsupported pass selections %j', patch => {
    const job = generateCam(readDxf(source()), { ...settings, ...patch } as CamSettings)
    expect(job.gcode).toBe('')
    expect(job.errors.join()).toContain('Profile pass selection')
  })
  it.each([12, 15, 18] as const)('uses exact %s mm stock depths, source feeds, spindle and clearances', thickness => {
    const job = result(thickness), preset = materialPreset(thickness)
    expect(job.errors).toEqual([])
    expect(job.simulation.warnings).toEqual([])
    expect(job.gcode).toContain('S18000 M03')
    expect(job.gcode).toContain('G00 Z20')
    expect(job.simulation.deepestCutMm).toBe(preset.depth)
    expect(job.operations.find(o => o.kind === 'drill')?.depthMm).toBe(preset.drill)
    expect(job.gcode).toContain(`G01 Z-${preset.drill} F600`)
    const profile = job.operations.find(o => o.kind === 'outside')!
    const profileCode = job.gcode.split('\n').slice(profile.firstLine - 1, profile.lastLine).join('\n')
    expect((profileCode.match(/\(Pass depth/g) ?? []).length).toBe(preset.passes.length)
    expect(job.operations.map(o => o.kind)).toEqual(thickness === 12 ? ['drill', 'inside', 'outside'] : ['drill', 'pocket', 'inside', 'outside'])
    for (const move of job.simulation.moves.filter(m => m.type === 'rapid' && distance(m.start, m.end) > 0.001)) {
      expect(move.start.z).toBe(20); expect(move.end.z).toBe(20)
    }
  })
  it('compensates profiles outward and doors inward by the 3.175 mm radius', () => {
    const job = generateCam(readDxf(source()), { ...settings, operations: { f1: { cornerOvercuts: false } } })
    for (const op of job.operations.filter(o => ['outside', 'inside'].includes(o.kind))) {
      const feature = job.drawing.features.find(f => f.id === op.featureId)!
      if (op.kind === 'outside') expect(feature.points.every(p => contains(op.path, p))).toBe(true)
      else expect(op.path.every(p => contains(feature.points, p))).toBe(true)
      const expected = Math.min(...feature.points.map(p => p.x)) + (op.kind === 'outside' ? -3.175 : 3.175)
      expect(Math.min(...op.path.map(p => p.x))).toBeCloseTo(expected, 3)
    }
  })
  it.each([12, 15, 18] as const)('keeps ramps at 3 degrees and never removes holding tabs for %s mm stock', thickness => {
    const job = result(thickness)
    for (const op of job.operations.filter(o => ['outside', 'inside'].includes(o.kind))) {
      expect(op.tabs.length).toBeGreaterThan(0); expect(op.tabs.length).toBeLessThanOrEqual(4)
      const moves = job.simulation.moves.filter(m => m.lineNumber >= op.firstLine && m.lineNumber <= op.lastLine)
      for (const m of moves.filter(m => m.end.z < m.start.z - 0.001 && distance(m.start, m.end) > 0.01)) {
        const angle = Math.atan2(m.start.z - m.end.z, distance(m.start, m.end)) * 180 / Math.PI
        expect(angle).toBeCloseTo(3, 1); expect(m.feedMmPerMinute).toBe(600)
      }
      for (const tab of op.tabs) {
        const midpoint = { x: (tab.start.x + tab.end.x) / 2, y: (tab.start.y + tab.end.y) / 2 }
        expect(distance(tab.start, tab.end)).toBeCloseTo(16.35, 2)
        for (const m of moves.filter(m => m.type !== 'rapid')) {
          const length = distance(m.start, m.end)
          if (length > 0.01 && Math.abs(distance(m.start, midpoint) + distance(midpoint, m.end) - length) < 0.001) {
            expect(Math.min(m.start.z, m.end.z)).toBeGreaterThanOrEqual(-(materialPreset(thickness).depth - 6) - 0.001)
          }
        }
      }
    }
  })
  it.each([12, 15, 18] as const)('drills at circle centres with the cutter regardless of DXF diameter in %s mm stock', thickness => {
    for (const diameter of [4, 6, 6.35, 12]) {
      const drawing = readDxf(dxf([circle(30, 30, diameter / 2, 'BORE_D6_DEPTH10')]))
      const job = generateCam(drawing, { ...settings, thickness })
      expect(job.errors).toEqual([])
      expect(job.warnings).toEqual([])
      expect(job.operations[0].depthMm).toBe(materialPreset(thickness).drill)
      const center = job.drawing.features[0].circle!.center
      const cuts = job.simulation.moves.filter(m => m.type !== 'rapid' && m.end.z < 0)
      expect(cuts.length).toBeGreaterThan(0)
      for (const move of cuts) {
        expect(move.start.x).toBeCloseTo(center.x, 3)
        expect(move.end.x).toBeCloseTo(center.x, 3)
        expect(move.start.y).toBeCloseTo(center.y, 3)
        expect(move.end.y).toBeCloseTo(center.y, 3)
      }
    }
  })
  it('rejects invalid tab counts, pocket depths, tiny pockets and intersecting profiles', () => {
    expect(generateCam(readDxf(source()), { ...settings, operations: { f0: { tabs: 5 } } }).gcode).toBe('')
    expect(generateCam(readDxf(source()), { ...settings, operations: { f3: { depthMm: 99 } } }).gcode).toBe('')
    expect(generateCam(readDxf(dxf([circle(20, 20, 2, 'POCKET')])), { ...settings, operations: { f0: { kind: 'pocket', depthMm: 6 } } }).gcode).toBe('')
    expect(generateCam(readDxf(dxf([rectangle(), rectangle(200, 0)])), settings).errors.join()).toContain('overlap')
    expect(generateCam(readDxf(dxf([rectangle(), rectangle(305, 0)])), settings).errors.join()).toContain('cutter paths overlap')
  })
  it.each([12, 15, 18] as const)('uses Z0.5 between pecks and Z20 between holes for %s mm stock', thickness => {
    const job = generateCam(readDxf(dxf([circle(30, 30, 3), circle(60, 30, 3)])), { ...settings, thickness })
    expect(job.errors).toEqual([])
    expect(job.gcode).not.toMatch(/reach check/i)
    expect(job.gcode.split('S18000 M03')[0]).not.toMatch(/G0[01].*[XY]/)
    const depths = thickness === 12 ? [2, 4, 4.5] : [2, 4, 6, 8, 9.2]
    const plunges = job.simulation.moves.filter(move => move.type !== 'rapid' && move.end.z < 0)
    expect(plunges.map(move => -move.end.z)).toEqual([...depths, ...depths])
    for (const [i, depth] of depths.entries()) expect(job.gcode).toContain(`G01 Z-${depth} F600\nG00 Z${i === depths.length - 1 ? 20 : 0.5}`)
    const retracts = job.simulation.moves.filter(move => move.type === 'rapid' && move.start.z < 0)
    expect(retracts.map(move => move.end.z)).toEqual([...depths, ...depths].map(depth => depth === depths.at(-1) ? 20 : 0.5))
    const lateral = job.simulation.moves.filter(move => move.type === 'rapid' && distance(move.start, move.end) > 0.001)
    expect(lateral.every(move => move.start.z === 20 && move.end.z === 20)).toBe(true)
    expect(job.gcode).not.toMatch(/G0?4\b|G8[13]\b/)
    const rapidsDown = job.simulation.moves.filter(move => move.type === 'rapid' && move.end.z < move.start.z)
    expect(rapidsDown.every(move => move.end.z >= 0.5)).toBe(true)
  })
  it('supports explicit exclusions without corrupting remaining operations', () => {
    const drawing = readDxf(dxf([rectangle(), [0, 'LINE', 10, 0, 20, 0, 11, 100, 21, 100]]))
    const unassigned = drawing.features.find(f => !f.closed)!
    const job = generateCam(drawing, { ...settings, operations: { [unassigned.id]: { kind: 'ignore' } } })
    expect(job.errors).toEqual([]); expect(job.operations).toHaveLength(1)
  })
  it('converts inch geometry to mm and keeps generated stock depths in mm', () => {
    const drawing = readDxf(dxf([rectangle(0, 0, 12, 8)], 1))
    const job = generateCam(drawing, settings)
    expect(job.errors).toEqual([])
    expect(Math.max(...job.drawing.features[0].points.map(p => p.x)) - Math.min(...job.drawing.features[0].points.map(p => p.x))).toBeCloseTo(304.8)
    expect(job.simulation.deepestCutMm).toBe(18.4)
  })
  it('blocks invalid material values even outside the UI', () => {
    expect(generateCam(readDxf(source()), { ...settings, thickness: 16 as 18 }).gcode).toBe('')
  })
  it('accepts drill-point geometry without requiring a nominal diameter', () => {
    const feature: CamFeature = { id: 'point', name: 'Point', layer: 'DRILL', points: [{ x: 10, y: 20 }], closed: false, kind: 'drill' }
    const drawing: CamDrawing = { features: [feature], errors: [], warnings: [], units: 'mm' }
    expect(generateCam(drawing, settings).errors).toEqual([])
  })
  it('cuts large circular internal openings through with holding tabs, not pocket clearing', () => {
    const drawing = readDxf(dxf([circle(40, 40, 13, 'CUT_INNER')]))
    const job = generateCam(drawing, settings)
    expect(drawing.features[0].kind).toBe('inside')
    expect(job.errors).toEqual([])
    expect(job.operations[0].depthMm).toBe(18.4)
    expect(job.operations[0].tabs.length).toBeGreaterThan(0)
    expect(job.gcode).not.toContain('G02')
    expect(job.warnings.join()).not.toContain('no holding tabs')
  })
  it.each([12, 15, 18] as const)('keeps doors and large internal openings tabbed in %s mm stock', thickness => {
    const parsed = readDxf(dxf([rectangle(), rectangle(20, 20, 80, 100, 'CUT_DOOR'), rectangle(150, 20, 100, 70, 'CUT_INNER'), circle(130, 150, 17.5, 'POCKET_D35_DEPTH12')]))
    const job = generateCam(parsed, { ...settings, thickness })
    expect(job.errors).toEqual([])
    expect(job.operations.find(op => op.featureId === 'f3')).toMatchObject({ kind: 'inside', depthMm: materialPreset(thickness).depth })
    expect(job.operations.find(op => op.featureId === 'f3')!.tabs.length).toBeGreaterThan(0)
    expect(job.operations.find(op => op.featureId === 'f1')!.tabs.length).toBeGreaterThan(0)
    expect(job.operations.find(op => op.featureId === 'f2')!.tabs).toHaveLength(4)
  })
  it.each([12, 15, 18] as const)('tabs all three unlabelled door outlines without hinge holes in %s mm stock', thickness => {
    const parsed = readDxf(dxf([rectangle(0, 0, 600, 300, '0'), circle(20, 20, 3), circle(40, 20, 3), circle(60, 20, 3), rectangle(30, 60, 130, 180, '0'), rectangle(220, 60, 130, 180, '0'), rectangle(410, 60, 130, 180, '0')]))
    const job = generateCam(parsed, { ...settings, thickness })
    expect(job.errors).toEqual([])
    expect(job.warnings.join()).not.toContain('no holding tabs')
    for (const id of ['f4', 'f5', 'f6']) {
      const op = job.operations.find(op => op.featureId === id)!
      expect(op.kind).toBe('inside')
      expect(op.tabs).toHaveLength(4)
      const moves = job.simulation.moves.filter(move => move.lineNumber >= op.firstLine && move.lineNumber <= op.lastLine)
      for (const tab of op.tabs) {
        const midpoint = { x: (tab.start.x + tab.end.x) / 2, y: (tab.start.y + tab.end.y) / 2 }
        const crossing = moves.filter(move => move.type !== 'rapid' && distance(move.start, move.end) > 0.01 && Math.abs(distance(move.start, midpoint) + distance(midpoint, move.end) - distance(move.start, move.end)) < 0.001)
        expect(crossing.length).toBeGreaterThan(0)
        expect(crossing.every(move => Math.min(move.start.z, move.end.z) >= -(materialPreset(thickness).depth - 6) - 0.001)).toBe(true)
      }
    }
  })
  it.each(['0', 'CUT_INNER', 'CUT_DOOR'])('allows hole tab removal but protects named doors on layer %s', layer => {
    const parsed = readDxf(dxf([rectangle(), rectangle(40, 40, 180, 120, layer)]))
    const job = generateCam(parsed, { ...settings, operations: { f1: { tabs: 0 } } })
    if (layer === 'CUT_DOOR') {
      expect(job.gcode).toBe('')
      expect(job.errors.join()).toContain('require holding tabs')
    } else {
      expect(job.errors).toEqual([])
      expect(job.operations.find(op => op.featureId === 'f1')!.tabs).toEqual([])
      expect(job.warnings.join()).toContain('no holding tabs')
    }
    const valid = generateCam(parsed, { ...settings, operations: { f1: { tabs: 2 } } })
    expect(valid.errors).toEqual([])
    expect(valid.operations.find(op => op.featureId === 'f1')!.tabs).toHaveLength(2)
  })
  it('allows tab removal after an inside-cut override but protects named doors cut outside', () => {
    const parsed = readDxf(dxf([rectangle()]))
    expect(generateCam(parsed, { ...settings, operations: { f0: { kind: 'inside', tabs: 0 } } }).errors).toEqual([])
    const door = readDxf(dxf([rectangle(0, 0, 300, 200, 'DOOR')]))
    expect(generateCam(door, { ...settings, operations: { f0: { kind: 'outside', tabs: 0 } } }).errors.join()).toContain('require holding tabs')
  })
  it('blocks an inside cut when no holding tab fits instead of suggesting tab removal', () => {
    const job = generateCam(readDxf(dxf([rectangle(0, 0, 15, 15, 'CUT_DOOR')])), { ...settings, operations: { f0: { cornerOvercuts: false } } })
    expect(job.gcode).toBe('')
    expect(job.errors.join()).toContain('cannot be exported without holding tabs')
    expect(job.errors.join()).not.toContain('set zero tabs')
  })
  it.each([[12, 12, false], [12.001, 8, true], [8, 12.001, true], [100, 8, true], [8, 100, true]])('uses uncompensated X/Y size %s x %s mm to require tabs: %s', (width, height, required) => {
    const feature = readDxf(dxf([rectangle(0, 0, Number(width), Number(height), 'CUT_INNER')])).features[0]
    expect(requiresHoldingTabs(feature)).toBe(false)
    expect(defaultTabCount(feature)).toBe(required ? 4 : 0)
    expect(requiresHoldingTabs({ ...feature, kind: 'outside' })).toBe(required)
    expect(requiresHoldingTabs({ ...feature, kind: 'pocket' })).toBe(false)
    expect(requiresHoldingTabs({ ...feature, kind: 'drill' })).toBe(false)
  })
  it.each([12, 15, 18] as const)('allows circle tab removal but protects outer profiles above 12 mm in %s mm stock', thickness => {
    for (const entity of [circle(50, 50, 20, 'CUT_INNER'), rectangle()]) {
      const parsed = readDxf(dxf([entity]))
      const valid = generateCam(parsed, { ...settings, thickness })
      expect(valid.errors).toEqual([])
      expect(valid.operations[0].tabs.length).toBeGreaterThan(0)
      expect(valid.operations[0].tabs.length).toBeLessThanOrEqual(4)
      const untabbed = generateCam(parsed, { ...settings, thickness, operations: { f0: { tabs: 0 } } })
      if (parsed.features[0].circle) {
        expect(untabbed.errors).toEqual([])
        expect(untabbed.operations[0].tabs).toEqual([])
        expect(untabbed.operations[0].depthMm).toBe(materialPreset(thickness).depth)
        expect(untabbed.gcode).not.toContain('(Tab ')
      } else expect(untabbed.errors.join()).toContain('require holding tabs')
    }
  })
  it('applies the size threshold in millimetres after inch conversion, and leaves 12 mm circles tab-free', () => {
    const small = readDxf(dxf([circle(30, 30, 6, 'CUT_INNER')]))
    expect(generateCam(small, settings).operations[0].tabs).toEqual([])
    const inch = readDxf(dxf([circle(2, 2, 0.5, 'CUT_INNER')], 1))
    const job = generateCam(inch, settings)
    expect(job.errors).toEqual([])
    expect(job.operations[0].tabs.length).toBeGreaterThan(0)
    expect(generateCam(inch, { ...settings, operations: { f0: { tabs: 0 } } }).operations[0].tabs).toEqual([])
  })
  it.each([15, 18] as const)('identifies 12 mm blind hinge pockets in %s mm stock and blocks 12 mm stock', thickness => {
    const parsed = readDxf(dxf([rectangle(0, 0, 300, 200, '0'), rectangle(20, 20, 100, 140, '0'), circle(55, 60, 17.5, '0')]))
    expect(parsed.features[1]).toMatchObject({ kind: 'inside', door: true })
    expect(parsed.features[2]).toMatchObject({ kind: 'pocket', hinge: true, depthMm: 12 })
    const thick = generateCam(parsed, { ...settings, thickness })
    expect(thick.errors).toEqual([])
    expect(thick.operations[0]).toMatchObject({ kind: 'pocket', depthMm: 12, tabs: [] })
    expect(thick.operations.find(o => o.featureId === 'f1')!.tabs.length).toBeGreaterThan(0)
    expect(generateCam(parsed, { ...settings, thickness, operations: { f1: { tabs: 0 } } }).errors.join()).toContain('require holding tabs')
    const thin = generateCam(parsed, { ...settings, thickness: 12 })
    expect(thin.gcode).toBe(''); expect(thin.errors.join()).toContain('only supported in 15 mm or 18 mm stock')
  })
  it('uses exactly 7.7/15.4 mm contour passes, 9.2 mm drills and 12 mm hinges for 15 mm stock', () => {
    expect(materialPreset(15)).toEqual({ depth: 15.4, passes: [7.7, 15.4], drill: 9.2 })
    const job = result(15)
    expect(job.errors).toEqual([])
    for (const op of job.operations) {
      const code = job.gcode.split('\n').slice(op.firstLine - 1, op.lastLine).join('\n')
      const moves = job.simulation.moves.filter(move => move.lineNumber >= op.firstLine && move.lineNumber <= op.lastLine)
      if (op.kind === 'inside' || op.kind === 'outside') {
        expect([...code.matchAll(/\(Pass depth ([\d.]+) mm\)/g)].map(match => Number(match[1]))).toEqual([7.7, 15.4])
        expect(Math.min(...moves.map(move => move.end.z))).toBe(-15.4)
      } else if (op.kind === 'drill') expect(Math.min(...moves.map(move => move.end.z))).toBe(-9.2)
      else if (op.kind === 'pocket') {
        expect(op.depthMm).toBe(12)
        expect(code).toContain('G01 Z-7.7 F600')
        expect(Math.min(...moves.map(move => move.end.z))).toBe(-12)
        expect(op.tabs).toEqual([])
      }
    }
  })
  it('uses selected drawing units and full containment for hinge detection', () => {
    const source = dxf([rectangle(0, 0, 10, 8, 'CUT_DOOR'), circle(2, 2, 17.5 / 25.4, '0')], 0)
    expect(readDxf(source, 'inches').features[1]).toMatchObject({ hinge: true, depthMm: 12 })
    expect(readDxf(source, 'mm').features[1].hinge).toBeUndefined()
    const crossing = readDxf(dxf([rectangle(0, 0, 100, 100, 'CUT_DOOR'), circle(95, 50, 17.5, '0')]))
    expect(crossing.features[1].hinge).toBeUndefined()
  })
  it('reimports generated components and exports two copies without an early program stop', () => {
    const generated = result()
    const part = createPartFromGCode('generated.nc', generated.gcode)
    expect(part.parsed.bodyLines.some(line => line.words.some(w => w.letter === 'M' && [5, 30].includes(w.value)))).toBe(false)
    const exported = exportCombinedGCode([part], {
      name: 'Generated pair', width: 1220, height: 1220, spacing: 30, borderSpacing: 10, screwMarkingEnabled: false, safeZOverrideMm: 20,
      gcodeSettings: { startGcode: 'G21\nG17\nG90\nG94', spindleStartGcode: 'S18000\nM03', endGcode: 'M05\nM30', safeZ: 20 },
      instances: [10, 360].map((x, i) => ({ id: `copy${i}`, partId: part.id, x, y: 10, rotation: 0, sheetIndex: 0, locked: false })),
    })
    expect(exported.errors).toEqual([])
    expect((exported.gcode.match(/^M30$/gm) ?? []).length).toBe(1)
    expect((exported.gcode.match(/Reach check:/g) ?? []).length).toBe(1)
    expect((exported.gcode.match(/\(No\. 1 drill machining/g) ?? []).length).toBe(2)
    expect(simulateGCode(exported.gcode).errors).toEqual([])
    expect(simulateGCode(exported.gcode).deepestCutMm).toBe(18.4)
    const parsed = parseGCode('G21\nG90\nM05\nG00 Z20\nS18000 M03\nG01 X10 Y10 Z-2 F600\nG00 Z20\nM05\nM30')
    expect(parsed.endLines.map(l => l.raw)).toEqual(['M05', 'M30'])
  })
  it('does not truncate source machining after an intermediate spindle pause', () => {
    const parsed = parseGCode('G21\nG90\nM05\nS18000 M03\nG01 X10 Y10 Z-2 F600\nG00 Z20\nM05\nM00\nS18000 M03\nG01 X20 Y20 Z-2 F600\nG00 Z20\nM05\nM30')
    expect(parsed.bodyLines.map(l => l.raw)).toContain('G01 X20 Y20 Z-2 F600')
    expect(parsed.bodyLines.map(l => l.raw)).toContain('M00')
    expect(parsed.endLines.map(l => l.raw)).toEqual(['M05', 'M30'])
  })
})
