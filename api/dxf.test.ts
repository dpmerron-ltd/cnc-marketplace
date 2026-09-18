// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { generateDxfNc } from './dxf'
import { readDxf } from '../src/cam/dxf'
import { generateCam } from '../src/cam/generate'
import { sha256 } from '../src/jobs/generateJob'

function dxf(entities: (string | number)[][], units = 4) {
  return [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, units, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', ...entities.flat(), 0, 'ENDSEC', 0, 'EOF', ''].join('\n')
}
const circle = (layer = 'BORE_D6_DEPTH10', x = 30) => [0, 'CIRCLE', 8, layer, 10, x, 20, 30, 40, 3]
const profile = [0, 'LWPOLYLINE', 8, 'CUT_OUTER', 90, 4, 70, 1, 10, 0, 20, 0, 10, 300, 20, 0, 10, 300, 20, 200, 10, 0, 20, 200]
const drawing = dxf([profile, circle()])

describe('DXF API generation', () => {
  it.each([12, 15, 18] as const)('exactly matches browser NC with %s mm stock', async thicknessMm => {
    const result = await generateDxfNc({ dxf: drawing, thicknessMm, filename: 'front panel.dxf' })
    const browser = generateCam(readDxf(drawing), { thickness: thicknessMm, units: 'auto', operations: {} })
    expect(result.gcode).toBe(browser.gcode)
    expect(result.filename).toBe('front panel.nc')
    expect(result.reviewRequired).toBe(true)
    expect(result.sha256).toBe(await sha256(result.gcode))
    expect(result.bytes).toBe(new TextEncoder().encode(result.gcode).length)
    expect(result.settings).toMatchObject({ cutterDiameterMm: 6.35, clearanceMm: 20, spindleRpm: 18000, drillPeckMm: 2, drillPeckRetractMm: 0.5, reachCheck: false, screwMarking: false })
    expect(result.operations.map(o => o.kind)).toEqual(['drill', 'outside'])
    expect(result.operations[1].tabCount).toBeLessThanOrEqual(4)
    expect(result.summary.deepestCutMm).toBe(thicknessMm === 18 ? 18.4 : thicknessMm === 15 ? 15.4 : 12.2)
    expect(result.settings.passDepthsMm).toEqual(thicknessMm === 18 ? [9.2, 18.4] : thicknessMm === 15 ? [7.7, 15.4] : [12.2])
    expect(result.gcode).not.toMatch(/reach check|screw mark/i)
    const depths = thicknessMm === 12 ? [2, 4, 4.5] : [2, 4, 6, 8, 9.2]
    for (const [i, depth] of depths.entries()) expect(result.gcode).toContain(`G01 Z-${depth} F600\nG00 Z${i === depths.length - 1 ? 20 : 0.5}`)
  })
  it('applies exact layer assignments then feature overrides, including prototype-like layer names', async () => {
    const source = dxf([circle('constructor'), circle('IGNORE', 60)])
    const result = await generateDxfNc({ dxf: source, thicknessMm: 18, layerOperations: { constructor: { kind: 'ignore' }, IGNORE: { kind: 'ignore' } }, operations: { f0: { kind: 'drill' } } })
    expect(result.operations).toHaveLength(1)
    expect(result.features.map(f => f.kind)).toEqual(['drill', 'ignore'])
    expect(result.operations[0].depthMm).toBe(9.2)
  })
  it('supports pocket depths and contour tab counts without changing material presets', async () => {
    const source = dxf([profile, [0, 'CIRCLE', 8, 'POCKET_D35_DEPTH12', 10, 50, 20, 50, 40, 17.5]])
    const result = await generateDxfNc({ dxf: source, thicknessMm: 18, layerOperations: { CUT_OUTER: { tabs: 2 }, POCKET_D35_DEPTH12: { kind: 'pocket', depthMm: 8 } } })
    expect(result.operations[0]).toMatchObject({ kind: 'pocket', depthMm: 8 })
    expect(result.operations[1]).toMatchObject({ kind: 'outside', depthMm: 18.4, tabCount: 2 })
  })
  it.each([12, 15, 18] as const)('allows explicit tab removal on non-door inside cuts in the API for %s mm stock', async thicknessMm => {
    const result = await generateDxfNc({ dxf: drawing, thicknessMm, operations: { f0: { kind: 'inside' }, f1: { kind: 'ignore' } } })
    expect(result.operations[0]).toMatchObject({ kind: 'inside', tabCount: 4 })
    expect(result.warnings.join()).not.toContain('no holding tabs')
    const untabbed = await generateDxfNc({ dxf: drawing, thicknessMm, layerOperations: { CUT_OUTER: { kind: 'inside', tabs: 0 } } })
    expect(untabbed.operations.find(op => op.kind === 'inside')!.tabCount).toBe(0)
    expect(untabbed.warnings.join()).toContain('no holding tabs')
  })
  it('defaults circular through-holes to tabs but accepts zero, without adding tabs to blind pockets', async () => {
    const source = dxf([[0, 'CIRCLE', 8, 'CUT_INNER', 10, 50, 20, 50, 40, 20]])
    const result = await generateDxfNc({ dxf: source, thicknessMm: 18 })
    expect(result.operations[0].tabCount).toBeGreaterThan(0)
    const untabbed = await generateDxfNc({ dxf: source, thicknessMm: 18, operations: { f0: { tabs: 0 } } })
    expect(untabbed.operations[0]).toMatchObject({ tabCount: 0, depthMm: 18.4 })
    expect(untabbed.gcode).not.toContain('(Tab ')
    const pocket = await generateDxfNc({ dxf: source, thicknessMm: 18, operations: { f0: { kind: 'pocket', depthMm: 6 } } })
    expect(pocket.operations[0]).toMatchObject({ kind: 'pocket', tabCount: 0 })
  })
  it.each([12, 15, 18] as const)('supports non-circular pockets with browser parity in %s mm stock', async thicknessMm => {
    const source = dxf([profile])
    const result = await generateDxfNc({ dxf: source, thicknessMm, operations: { f0: { kind: 'pocket', depthMm: 6 } } })
    const browser = generateCam(readDxf(source), { thickness: thicknessMm, units: 'auto', operations: { f0: { kind: 'pocket', depthMm: 6 } } })
    expect(result.gcode).toBe(browser.gcode)
    expect(result.operations[0]).toMatchObject({ kind: 'pocket', depthMm: 6, tabCount: 0 })
    expect(result.summary.deepestCutMm).toBe(6)
    expect(result.reviewRequired).toBe(true)
  })
  it('supports corner relief overrides and rejects through-depth blind pockets', async () => {
    const source = dxf([profile])
    const result = await generateDxfNc({ dxf: source, thicknessMm: 18, operations: { f0: { kind: 'pocket', depthMm: 12, cornerOvercuts: false } } })
    expect(result.gcode).not.toContain('Automatic corner overcuts')
    await expect(generateDxfNc({ dxf: source, thicknessMm: 12, operations: { f0: { kind: 'pocket', depthMm: 12 } } })).rejects.toMatchObject({ status: 422 })
    await expect(generateDxfNc({ dxf: source, thicknessMm: 18, operations: { f0: { cornerOvercuts: true } } })).rejects.toMatchObject({ status: 400 })
  })
  it.each([
    { thicknessMm: 16 }, { ownerId: 'someone' }, { feed: 2000 }, { filename: '../part.dxf' }, { filename: 'part.nc' },
    { layerOperations: { TYPO: { kind: 'drill' } } }, { operations: { f999: { kind: 'drill' } } },
    { operations: { f0: { tabs: 5 } } }, { operations: { f1: { depthMm: 3 } } }, { operations: { f1: { tabs: 2 } } },
    { operations: { f1: { useToolDiameter: true } } },
  ])('rejects invalid or silently ineffective request overrides: %j', async patch => {
    await expect(generateDxfNc({ dxf: drawing, thicknessMm: 18, ...patch })).rejects.toMatchObject({ status: 400 })
  })
  it('returns validation failures without any NC for malformed, unsupported and open geometry', async () => {
    for (const source of ['not a DXF', dxf([[0, 'INSERT', 2, 'block', 10, 0, 20, 0]]), dxf([[0, 'LINE', 10, 0, 20, 0, 11, 40, 21, 20]])]) {
      await expect(generateDxfNc({ dxf: source, thicknessMm: 18 })).rejects.toMatchObject({ status: 422 })
    }
  })
  it('supports explicit unit selection and reports unspecified units for review', async () => {
    const source = dxf([circle()], 0)
    expect((await generateDxfNc({ dxf: source, thicknessMm: 12 })).warnings.join()).toContain('unspecified')
    const result = await generateDxfNc({ dxf: source, thicknessMm: 12, units: 'inches' })
    expect(result.settings.drawingUnits).toBe('inches')
    expect(result.gcode).toBe(generateCam(readDxf(source), { thickness: 12, units: 'inches', operations: {} }).gcode)
  })
  it('bounds source byte size and feature count before generation', async () => {
    await expect(generateDxfNc({ dxf: '\u00e9'.repeat(1000001), thicknessMm: 18 })).rejects.toMatchObject({ status: 413 })
    await expect(generateDxfNc({ dxf: dxf(Array.from({ length: 101 }, (_, i) => circle('DRILL', i * 10))), thicknessMm: 18 })).rejects.toMatchObject({ status: 422, message: expect.stringContaining('100 features') })
  })
})
