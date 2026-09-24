// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { generateDxfNc } from './dxf'
import { readDxf } from '../src/cam/dxf'
import { generateCam } from '../src/cam/generate'
import { sha256 } from '../src/jobs/generateJob'
import { materialProfiles } from '../src/cam/materialProfiles'
import { parseComponent } from './components'

function dxf(entities: (string | number)[][], units = 4) {
  return [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, units, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', ...entities.flat(), 0, 'ENDSEC', 0, 'EOF', ''].join('\n')
}
const circle = (layer = 'BORE_D6_DEPTH10', x = 30) => [0, 'CIRCLE', 8, layer, 10, x, 20, 30, 40, 3]
const profile = [0, 'LWPOLYLINE', 8, 'CUT_OUTER', 90, 4, 70, 1, 10, 0, 20, 0, 10, 300, 20, 0, 10, 300, 20, 200, 10, 0, 20, 200]
const drawing = dxf([profile, circle()])

describe('DXF API generation', () => {
  it('returns all profiles as an uploadable bundle while retaining the requested primary response', async () => {
    const result = await generateDxfNc({ dxf: drawing, thicknessMm: 6, operations: { f0: { tabs: 2 } } })
    expect(result.materialVariants.primaryProfile).toBe('6')
    expect(result.materialVariants.profiles['6'].gcode).toBe(result.gcode)
    for (const profile of materialProfiles) {
      expect(result.materialVariants.profiles[profile.id]!.errors).toEqual([])
      expect(result.materialVariants.profiles[profile.id]!.gcode).toBe(generateCam(readDxf(drawing), { thickness: profile.thickness, drillDepthMm: profile.drillDepthMm, profilePasses: profile.thickness === 12 ? profile.profilePasses : undefined, units: 'auto', operations: { f0: { tabs: 2 } } }).gcode)
    }
    const uploaded = parseComponent({ id: '20000000-0000-4000-8000-000000000001', name: 'Panel', sku: 'PANEL', filename: 'panel.nc', dxf: drawing, gcode: result.gcode, materialVariants: result.materialVariants }, 'alice', '10000000-0000-4000-8000-000000000001')
    expect(uploaded.part.metadata.materialVariants).toEqual(result.materialVariants)
  })
  it('supports single-pass 6 mm stock with unchanged feeds, spindle, clearance and browser parity', async () => {
    const result = await generateDxfNc({ dxf: drawing, thicknessMm: 6 })
    expect(result.gcode).toBe(generateCam(readDxf(drawing), { thickness: 6, units: 'auto', operations: {} }).gcode)
    expect(result.settings).toMatchObject({ thicknessMm: 6, cutDepthMm: 6.2, passDepthsMm: [6.2], drillDepthMm: 4.5, spindleRpm: 18000, cutFeedMmPerMinute: 3000, rampFeedMmPerMinute: 600, clearanceMm: 20 })
    expect(result.summary.deepestCutMm).toBe(6.2)
    expect(result.operations.find(op => op.kind === 'outside')).toMatchObject({ depthMm: 6.2, tabCount: 4 })
    expect(result.gcode.match(/Pass depth /g)).toHaveLength(1)
    expect(result.gcode).not.toContain('Z-12.2')
    await expect(generateDxfNc({ dxf: drawing, thicknessMm: 6, profilePasses: 2 })).rejects.toMatchObject({ status: 400 })
  })
  it.each([12, 15, 18] as const)('automatically cuts narrow rectangular holes tab-free in %s mm stock', async thicknessMm => {
    const slot = [0, 'LWPOLYLINE', 8, 'CUT_INNER', 90, 4, 70, 1, 10, 50, 20, 50, 10, 150, 20, 50, 10, 150, 20, 53, 10, 50, 20, 53]
    const source = dxf([profile, slot, circle()])
    const result = await generateDxfNc({ dxf: source, thicknessMm })
    expect(result.gcode).toBe(generateCam(readDxf(source), { thickness: thicknessMm, units: 'auto', operations: {} }).gcode)
    expect(result.operations.find(op => op.featureId === 'f1')).toMatchObject({ kind: 'inside', tabCount: 0, depthMm: thicknessMm === 18 ? 18.4 : thicknessMm === 15 ? 15.4 : 12.2 })
    expect(result.operations.find(op => op.featureId === 'f0')?.tabCount).toBe(4)
    expect(result.warnings.join()).toContain('widened from 3 mm to the 6.35 mm cutter')
    expect(result.settings.drillDepthMm).toBe(thicknessMm === 12 ? 4.5 : 9.2)
    const overridden = await generateDxfNc({ dxf: source, thicknessMm, operations: { f1: { tabs: 2 } } })
    expect(overridden.operations.find(op => op.featureId === 'f1')?.tabCount).toBe(0)
  })
  it.each([undefined, 1])('supports one-pass 12 mm stock with 2 mm drills (passes %s), preserving all other machining', async profilePasses => {
    const source = dxf([profile, circle(), [0, 'CIRCLE', 8, 'POCKET', 10, 100, 20, 100, 40, 10]])
    const input = { dxf: source, thicknessMm: 12, filename: 'panel.dxf', layerOperations: { POCKET: { kind: 'pocket', depthMm: 5 } } }
    const normal = await generateDxfNc(input)
    const shallow = await generateDxfNc({ ...input, profilePasses, drillDepthMm: 2, variantProfiles: materialProfiles.map(profile => profile.id) })
    expect(shallow.settings).toEqual({ ...normal.settings, drillDepthMm: 2 })
    expect(shallow.settings).toMatchObject({ passDepthsMm: [12.2], cutDepthMm: 12.2, drillDepthMm: 2, cutterDiameterMm: 6.35, clearanceMm: 20, cutFeedMmPerMinute: 3000, spindleRpm: 18000, rampDegrees: 3 })
    expect(shallow.filename).toBe('panel-12mm-2mm-holes.nc')
    expect(shallow.materialVariants.primaryProfile).toBe('12-2mm')
    expect(shallow.materialVariants.profiles['12-2mm']?.gcode).toBe(shallow.gcode)
    expect(shallow.gcode).toBe(generateCam(readDxf(source), { thickness: 12, drillDepthMm: 2, units: 'auto', operations: { f2: { kind: 'pocket', depthMm: 5 } } }).gcode)
    for (const operation of shallow.operations) {
      const block = shallow.gcode.split('\n').slice(operation.firstLine - 1, operation.lastLine).join('\n')
      if (operation.kind === 'drill') {
        expect(operation.depthMm).toBe(2)
        expect(block.match(/G01 Z-\d[^\n]*/g)).toEqual(['G01 Z-2 F600'])
        expect(block).toContain('G00 Z20')
      } else {
        const original = normal.operations.find(value => value.featureId === operation.featureId)!
        expect(block).toBe(normal.gcode.split('\n').slice(original.firstLine - 1, original.lastLine).join('\n'))
      }
    }
    const uploaded = parseComponent({ id: '20000000-0000-4000-8000-000000000001', name: 'Panel', sku: 'PANEL', filename: shallow.filename, gcode: shallow.gcode, materialVariants: shallow.materialVariants }, 'alice', '10000000-0000-4000-8000-000000000001')
    expect(uploaded.part.metadata.materialVariants?.primaryProfile).toBe('12-2mm')
    const older = structuredClone(normal.materialVariants)
    delete older.profiles['12-2mm']
    expect(parseComponent({ id: '20000000-0000-4000-8000-000000000001', name: 'Old panel', sku: 'OLD', filename: normal.filename, gcode: normal.gcode, materialVariants: older }, 'alice', '10000000-0000-4000-8000-000000000001').part.metadata.materialVariants?.profiles['12-2mm']).toBeUndefined()
  })
  it.each([{ thicknessMm: 6 }, { thicknessMm: 15 }, { thicknessMm: 18 }, { thicknessMm: 12, profilePasses: 2 }])('rejects unsupported 2 mm drilling combinations %j', async patch => {
    await expect(generateDxfNc({ dxf: drawing, drillDepthMm: 2, ...patch })).rejects.toMatchObject({ status: 400 })
  })
  it('supports opt-in two-pass 12 mm generation with exact browser parity', async () => {
    const result = await generateDxfNc({ dxf: drawing, thicknessMm: 12, profilePasses: 2, filename: 'panel.dxf' })
    expect(result.gcode).toBe(generateCam(readDxf(drawing), { thickness: 12, profilePasses: 2, units: 'auto', operations: {} }).gcode)
    expect(result.filename).toBe('panel-12mm-2pass.nc')
    expect(result.settings).toMatchObject({ passDepthsMm: [6.1, 12.2], cutDepthMm: 12.2, drillDepthMm: 4.5, clearanceMm: 20 })
    expect(result.operations.find(o => o.kind === 'outside')?.tabCount).toBe(4)
    const single = await generateDxfNc({ dxf: drawing, thicknessMm: 12, profilePasses: 1 })
    expect(single.gcode).toBe((await generateDxfNc({ dxf: drawing, thicknessMm: 12 })).gcode)
  })
  it('forces a 12 mm wide opening tab-free in every generated material variant', async () => {
    const slot = [0, 'LWPOLYLINE', 8, 'CUT_INNER', 90, 4, 70, 1, 10, 0, 20, 0, 10, 100, 20, 0, 10, 100, 20, 12, 10, 0, 20, 12]
    const result = await generateDxfNc({ dxf: dxf([slot]), thicknessMm: 18, operations: { f0: { tabs: 4 } } })
    expect(result.operations[0].tabCount).toBe(0)
    for (const variant of Object.values(result.materialVariants.profiles)) {
      expect(variant.errors).toEqual([])
      expect(variant.gcode).not.toContain('(Tab ')
      expect(variant.gcode).not.toBe('')
    }
  })
  it.each([{ thicknessMm: 12, profilePasses: 0 }, { thicknessMm: 12, profilePasses: 3 }, { thicknessMm: 12, profilePasses: '2' }, { thicknessMm: 15, profilePasses: 2 }, { thicknessMm: 18, profilePasses: 1 }])('rejects unsupported pass selections %j', async patch => {
    await expect(generateDxfNc({ dxf: drawing, ...patch })).rejects.toMatchObject({ status: 400 })
  })
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

describe('18 mm profile with 9 mm holes', () => {
  it('keeps drilling at 9 mm with unchanged cutter, profiles, hinges and legacy variants', async () => {
    const result = await generateDxfNc({ dxf: drawing, thicknessMm: 18, drillDepthMm: 9, filename: 'panel.dxf' })
    expect(result.settings).toMatchObject({ cutterDiameterMm: 6.35, drillDepthMm: 9, passDepthsMm: [9.2, 18.4], cutDepthMm: 18.4 })
    expect(result.operations.find(op => op.kind === 'drill')?.depthMm).toBe(9)
    expect(result.gcode).toContain('G01 Z-9 F600\nG00 Z20')
    expect(result.filename).toBe('panel-18mm-9mm-holes.nc')
    expect(result.materialVariants.primaryProfile).toBe('18-9mm')
    expect(result.materialVariants.profiles['18-9mm']?.gcode).toBe(result.gcode)
    expect(result.materialVariants.profiles['18'].gcode).toBe((await generateDxfNc({ dxf: drawing, thicknessMm: 18 })).gcode)
    const uploaded = parseComponent({ id: '20000000-0000-4000-8000-000000000001', name: 'Panel', sku: 'PANEL', filename: result.filename, dxf: drawing, gcode: result.gcode, materialVariants: result.materialVariants }, 'alice', '10000000-0000-4000-8000-000000000001')
    expect(uploaded.part.metadata.materialVariants?.primaryProfile).toBe('18-9mm')
    const hinge = await generateDxfNc({ dxf: dxf([profile, [0, 'CIRCLE', 8, 'HINGE', 10, 50, 20, 50, 40, 17.5]]), thicknessMm: 18, drillDepthMm: 9, layerOperations: { HINGE: { kind: 'pocket', depthMm: 12 } } })
    expect(hinge.operations.find(op => op.kind === 'pocket')?.depthMm).toBe(12)
  })
  it.each([{ thicknessMm: 12, drillDepthMm: 9 }, { thicknessMm: 15, drillDepthMm: 9 }, { thicknessMm: 18, drillDepthMm: 8 }, { thicknessMm: 18, drillDepthMm: 9.2 }])('rejects unsupported profile combinations %j', async patch => {
    await expect(generateDxfNc({ dxf: drawing, ...patch })).rejects.toMatchObject({ status: 400 })
  })
  it('accepts original five-profile bundles without fabricating the new profile', async () => {
    const result = await generateDxfNc({ dxf: drawing, thicknessMm: 18 })
    delete result.materialVariants.profiles['18-9mm']
    const uploaded = parseComponent({ id: '20000000-0000-4000-8000-000000000001', name: 'Legacy', sku: 'LEGACY', filename: 'legacy.nc', gcode: result.gcode, materialVariants: result.materialVariants }, 'alice', '10000000-0000-4000-8000-000000000001')
    expect(uploaded.part.metadata.materialVariants?.profiles['18-9mm']).toBeUndefined()
    await expect(generateDxfNc({ dxf: drawing, thicknessMm: 18 })).resolves.toBeDefined()
    expect(() => parseComponent({ id: '20000000-0000-4000-8000-000000000001', name: 'Bad', sku: 'BAD', filename: 'bad.nc', gcode: result.gcode, materialVariants: { ...result.materialVariants, primaryProfile: '18-9mm' } }, 'alice', '10000000-0000-4000-8000-000000000001')).toThrow('Invalid component')
  })
})

it.each(['CUT_DOOR_SHARED_ON_LINE', 'RELEASE_TOOL_CENTRE_6_35'])('preserves explicit shared-release centreline on %s with holding tabs', async layer => {
  const release = [0, 'LWPOLYLINE', 8, layer, 90, 4, 70, 1, 10, 50, 20, 50, 10, 150, 20, 50, 10, 150, 20, 150, 10, 50, 20, 150]
  const source = dxf([profile, release])
  const drawing = readDxf(source)
  expect(drawing.features[1]).toMatchObject({ kind: 'inside', door: true, toolCentreline: true })
  const result = generateCam(drawing, { thickness: 18, drillDepthMm: 9, units: 'mm', operations: {} })
  expect(result.errors).toEqual([])
  const operation = result.operations.find(op => op.featureId === 'f1')!
  const xs = operation.path.map(p => p.x), ys = operation.path.map(p => p.y)
  expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100)
  expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(100)
  expect(operation.tabs).toHaveLength(4)
  expect(result.gcode).toContain('Shared release: tool centre follows source contour')
  await expect(generateDxfNc({ dxf: source, thicknessMm: 18, operations: { f1: { tabs: 0 } } })).rejects.toMatchObject({ status: 422 })
})

it('limits optional variant generation without changing the primary program or fabricating alternatives', async () => {
  const all = await generateDxfNc({ dxf: drawing, thicknessMm: 12 })
  const selected = await generateDxfNc({ dxf: drawing, thicknessMm: 12, variantProfiles: ['12'] })
  expect(selected.gcode).toBe(all.gcode)
  expect(selected.materialVariants.profiles['12']).toEqual(all.materialVariants.profiles['12'])
  for (const [id, variant] of Object.entries(selected.materialVariants.profiles)) {
    if (id !== '12') expect(variant).toMatchObject({ gcode: '', errors: [expect.stringContaining('Not generated')] })
  }
  expect(() => parseComponent({ id: '20000000-0000-4000-8000-000000000001', name: 'Dense panel', sku: 'DENSE', filename: selected.filename, gcode: selected.gcode, dxf: drawing, materialVariants: selected.materialVariants }, 'alice', '10000000-0000-4000-8000-000000000001')).not.toThrow()
  for (const variantProfiles of [[], ['18'], ['12', '12'], ['unknown']]) await expect(generateDxfNc({ dxf: drawing, thicknessMm: 12, variantProfiles })).rejects.toMatchObject({ status: 400 })
})
