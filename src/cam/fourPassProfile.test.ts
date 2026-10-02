import { expect, it } from 'vitest'
import { generateDxfNc } from '../../api/dxf'
import { parseComponent } from '../../api/components'
import { parseImportProfile } from '../../api/itemImports'
import { materialVariantsSchema } from './materialProfiles'
import { simulateGCode } from '../gcode/simulator'
import { selectMaterialParts } from '../gcode/materialSelection'
import { generateJob, parseJobRequest } from '../jobs/generateJob'
import { testItem } from '../test/jobFixtures'
import { readDxf } from './dxf'
import { generateCam } from './generate'
import type { CamSettings } from './types'

const id = '14-4pass-2mm-ramp10-5deg'
const options = { thicknessMm: 14, profilePasses: 4, drillDepthMm: 2, rampProfile: '10mm-s-5deg' } as const
const dxf = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', 0, 'LWPOLYLINE', 8, 'PROFILE', 90, 4, 70, 1, 10, 0, 20, 0, 10, 180, 20, 0, 10, 180, 20, 100, 10, 0, 20, 100, 0, 'CIRCLE', 8, 'DRILL', 10, 30, 20, 30, 40, 3.175, 0, 'ENDSEC', 0, 'EOF', ''].join('\n')

it('generates four 3.6 mm passes, 2 mm drills, F3000 cuts and F600 ramps at up to 5 degrees', async () => {
  const result = await generateDxfNc({ dxf, ...options })
  expect(result.settings).toMatchObject({ cutterDiameterMm: 6.35, thicknessMm: 14, passDepthsMm: [3.6, 7.2, 10.8, 14.4], cutDepthMm: 14.4, drillDepthMm: 2, cutFeedMmPerMinute: 3000, rampFeedMmPerMinute: 600, rampDegrees: 5, clearanceMm: 20 })
  expect(result.filename).toBe('component-14mm-4pass-2mm-holes-ramp10-5deg.nc')
  expect(result.materialVariants.primaryProfile).toBe(id)
  expect(result.gcode.match(/\(Pass depth [\d.]+ mm\)/g)).toEqual([3.6, 7.2, 10.8, 14.4].map(depth => `(Pass depth ${depth} mm)`))
  const drill = result.operations.find(op => op.kind === 'drill')!
  expect(drill.depthMm).toBe(2)
  expect(result.gcode.split('\n').slice(drill.firstLine - 1, drill.lastLine).join('\n')).toContain('G01 Z-2 F600\nG00 Z20')
  const simulation = simulateGCode(result.gcode)
  expect(simulation.errors).toEqual([])
  expect(simulation.deepestCutMm).toBe(14.4)
  const ramps = simulation.moves.filter(m => m.type !== 'rapid' && m.end.z < m.start.z - 0.001 && Math.hypot(m.end.x - m.start.x, m.end.y - m.start.y) > 0.001)
  expect(ramps.length).toBeGreaterThan(0)
  for (const move of ramps) {
    expect(move.feedMmPerMinute).toBe(600)
    expect(Math.atan((move.start.z - move.end.z) / Math.hypot(move.end.x - move.start.x, move.end.y - move.start.y)) * 180 / Math.PI).toBeLessThanOrEqual(5.01)
  }
  const cuts = simulation.moves.filter(m => m.type !== 'rapid' && m.end.z < 0 && Math.abs(m.start.z - m.end.z) < 0.001 && Math.hypot(m.end.x - m.start.x, m.end.y - m.start.y) > 0.001)
  expect(cuts.length).toBeGreaterThan(0)
  expect(cuts.every(m => m.feedMmPerMinute === 3000)).toBe(true)
  expect(result.operations.find(op => op.kind === 'outside')?.tabCount).toBe(4)
  expect(result.materialVariants.profiles['12-2pass'].gcode).toContain('Pass depth 6.1')
  expect(result.materialVariants.profiles['12-2pass-2mm-ramp20-5deg']?.gcode).toContain('Pass depth 12.2')
})

it('validates uploads and selects the exact profile for jobs without changing older bundles', async () => {
  const result = await generateDxfNc({ dxf, ...options })
  const input = { id: '20000000-0000-4000-8000-000000000001', name: 'Panel', sku: 'TEST', filename: result.filename, gcode: result.gcode, dxf, materialVariants: result.materialVariants }
  const staged = { componentId: input.id, profileId: id, ...result.materialVariants.profiles[id]! }
  expect(parseImportProfile(staged, 'alice', testItem.id).gcode).toBe(result.gcode)
  expect(() => parseImportProfile({ ...staged, gcode: result.gcode.replaceAll('Z-14.4 ', 'Z-14.6 ') }, 'alice', testItem.id)).toThrow('cuts deeper than its material preset')
  const part = parseComponent(input, 'alice', testItem.id).part
  const request = parseJobRequest({ jobName: 'Two passes', orderNumber: 'TEST', items: [{ itemId: testItem.id, quantity: 1 }], sheet: { widthMm: 500, heightMm: 400, material: 'Plywood', ...options, screwMarks: false } })
  const job = await generateJob(request, [testItem], [part])
  expect(job.sheet.materialProfile).toBe(id)
  expect(job.simulations[0].deepestCutMm).toBe(14.4)
  const original = selectMaterialParts([part], { materialProfile: '12', instances: [{ partId: part.id }] })
  expect(original.parts[0].originalFilename).toBe('component-12mm.nc')
  expect(selectMaterialParts(original.parts, { materialProfile: id, instances: [{ partId: part.id }] }).parts[0].originalFilename).toBe(result.filename)
  const older = structuredClone(result.materialVariants)
  delete older.profiles[id]
  older.primaryProfile = '12'
  expect(materialVariantsSchema.safeParse(older).success).toBe(true)
  await expect(generateJob(request, [testItem], [{ ...part, metadata: { ...part.metadata, materialVariants: older } }])).rejects.toThrow('unavailable')
  const tooDeep = structuredClone(result.materialVariants)
  tooDeep.profiles[id]!.gcode = result.gcode.replaceAll('Z-14.4 ', 'Z-14.6 ')
  expect(() => parseComponent({ ...input, gcode: tooDeep.profiles[id]!.gcode, materialVariants: tooDeep }, 'alice', testItem.id)).toThrow('cuts deeper than its material preset')
  expect((await generateDxfNc({ dxf, thicknessMm: 12 })).materialVariants.profiles[id]?.errors).toEqual([])
  const limited = await generateDxfNc({ dxf, ...options, variantProfiles: [id] })
  expect(limited.materialVariants.profiles[id]?.gcode).toBe(result.gcode)
})

it.each([
  { thicknessMm: 14, profilePasses: undefined, drillDepthMm: undefined, rampProfile: undefined }, { ...options, profilePasses: undefined },
  { ...options, drillDepthMm: undefined }, { ...options, rampProfile: undefined },
  { ...options, profilePasses: 2 }, { ...options, drillDepthMm: 9 },
  { ...options, rampProfile: '20mm-s-5deg' },
  ...[6, 12, 15, 18].map(thicknessMm => ({ ...options, thicknessMm })),
])('rejects unsupported four-pass combinations without generating NC: %j', async input => {
  await expect(generateDxfNc({ dxf, ...input })).rejects.toMatchObject({ status: 400 })
  expect(() => parseJobRequest({ jobName: 'Invalid', orderNumber: 'TEST', items: [{ itemId: testItem.id, quantity: 1 }], sheet: { widthMm: 500, heightMm: 400, material: 'Plywood', ...input } })).toThrow('Invalid job request')
  const result = generateCam(readDxf(dxf), { thickness: input.thicknessMm, profilePasses: input.profilePasses, drillDepthMm: input.drillDepthMm, rampProfile: input.rampProfile, units: 'auto', operations: {} } as CamSettings)
  expect(result.errors.length).toBeGreaterThan(0)
  expect(result.gcode).toBe('')
})

it('uses the four-pass schedule for blind pockets without tabs, but keeps automatic hinges restricted to 15/18 mm', () => {
  const drawing = readDxf(dxf)
  const pocket = { ...drawing.features[0], kind: 'pocket' as const, depthMm: 12 }
  const settings: CamSettings = { thickness: 14, profilePasses: 4, drillDepthMm: 2, rampProfile: '10mm-s-5deg', units: 'auto', operations: {} }
  const result = generateCam({ ...drawing, features: [pocket] }, settings)
  expect(result.errors).toEqual([])
  expect(result.gcode.match(/\(Pass depth [\d.]+ mm\)/g)).toEqual([3.6, 7.2, 10.8, 12].map(depth => `(Pass depth ${depth} mm)`))
  expect(result.operations[0].tabs).toEqual([])
  const hinge = generateCam({ ...drawing, features: [{ ...pocket, hinge: true }] }, settings)
  expect(hinge.gcode).toBe('')
  expect(hinge.errors.join()).toContain('only supported in 15 mm or 18 mm')
})
