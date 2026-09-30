import { expect, it } from 'vitest'
import { generateDxfNc } from '../../api/dxf'
import { parseComponent } from '../../api/components'
import { materialVariantsSchema } from './materialProfiles'
import { simulateGCode } from '../gcode/simulator'
import { selectMaterialParts } from '../gcode/materialSelection'
import { generateJob, parseJobRequest } from '../jobs/generateJob'
import { testItem } from '../test/jobFixtures'

const id = '12-2pass-2mm-depth12p4'
const options = { thicknessMm: 12, profilePasses: 2, drillDepthMm: 2 } as const
const dxf = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', 0, 'LWPOLYLINE', 8, 'PROFILE', 90, 4, 70, 1, 10, 0, 20, 0, 10, 180, 20, 0, 10, 180, 20, 100, 10, 0, 20, 100, 0, 'CIRCLE', 8, 'DRILL', 10, 30, 20, 30, 40, 3.175, 0, 'ENDSEC', 0, 'EOF', ''].join('\n')

it('generates two 6.2 mm passes, 2 mm drills, F3000 cuts and F600 ramps at up to 3 degrees', async () => {
  const result = await generateDxfNc({ dxf, ...options })
  expect(result.settings).toMatchObject({ cutterDiameterMm: 6.35, thicknessMm: 12, passDepthsMm: [6.2, 12.4], cutDepthMm: 12.4, drillDepthMm: 2, cutFeedMmPerMinute: 3000, rampFeedMmPerMinute: 600, rampDegrees: 3, clearanceMm: 20 })
  expect(result.filename).toBe('component-12mm-2pass-2mm-holes-depth12p4.nc')
  expect(result.materialVariants.primaryProfile).toBe(id)
  expect(result.gcode).toContain('(Pass depth 6.2 mm)')
  expect(result.gcode).toContain('(Pass depth 12.4 mm)')
  const drill = result.operations.find(op => op.kind === 'drill')!
  expect(drill.depthMm).toBe(2)
  expect(result.gcode.split('\n').slice(drill.firstLine - 1, drill.lastLine).join('\n')).toContain('G01 Z-2 F600\nG00 Z20')
  const simulation = simulateGCode(result.gcode)
  expect(simulation.errors).toEqual([])
  expect(simulation.deepestCutMm).toBe(12.4)
  const ramps = simulation.moves.filter(m => m.type !== 'rapid' && m.end.z < m.start.z - 0.001 && Math.hypot(m.end.x - m.start.x, m.end.y - m.start.y) > 0.001)
  expect(ramps.length).toBeGreaterThan(0)
  for (const move of ramps) {
    expect(move.feedMmPerMinute).toBe(600)
    expect(Math.atan((move.start.z - move.end.z) / Math.hypot(move.end.x - move.start.x, move.end.y - move.start.y)) * 180 / Math.PI).toBeLessThanOrEqual(3.01)
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
  const part = parseComponent(input, 'alice', testItem.id).part
  const request = parseJobRequest({ jobName: 'Two passes', orderNumber: 'TEST', items: [{ itemId: testItem.id, quantity: 1 }], sheet: { widthMm: 500, heightMm: 400, material: 'Plywood', ...options, screwMarks: false } })
  const job = await generateJob(request, [testItem], [part])
  expect(job.sheet.materialProfile).toBe(id)
  expect(job.simulations[0].deepestCutMm).toBe(12.4)
  const original = selectMaterialParts([part], { materialProfile: '12', instances: [{ partId: part.id }] })
  expect(original.parts[0].originalFilename).toBe('component-12mm.nc')
  expect(selectMaterialParts(original.parts, { materialProfile: id, instances: [{ partId: part.id }] }).parts[0].originalFilename).toBe(result.filename)
  const older = structuredClone(result.materialVariants)
  delete older.profiles[id]
  older.primaryProfile = '12'
  expect(materialVariantsSchema.safeParse(older).success).toBe(true)
  await expect(generateJob(request, [testItem], [{ ...part, metadata: { ...part.metadata, materialVariants: older } }])).rejects.toThrow('unavailable')
  const tooDeep = structuredClone(result.materialVariants)
  tooDeep.profiles[id]!.gcode = result.gcode.replaceAll('Z-12.4 ', 'Z-12.6 ')
  expect(() => parseComponent({ ...input, gcode: tooDeep.profiles[id]!.gcode, materialVariants: tooDeep }, 'alice', testItem.id)).toThrow('cuts deeper than its material preset')
  expect((await generateDxfNc({ dxf, thicknessMm: 12 })).materialVariants.profiles[id]?.errors).toEqual([])
  const limited = await generateDxfNc({ dxf, ...options, variantProfiles: [id] })
  expect(limited.materialVariants.profiles[id]?.gcode).toBe(result.gcode)
})
