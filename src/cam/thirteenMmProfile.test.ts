// @vitest-environment node
import { expect, it } from 'vitest'
import { generateDxfNc } from '../../api/dxf'
import { parseComponent } from '../../api/components'
import { materialVariantsSchema } from './materialProfiles'
import { simulateGCode } from '../gcode/simulator'
import { selectMaterialParts } from '../gcode/materialSelection'
import { generateJob, parseJobRequest } from '../jobs/generateJob'
import { testItem } from '../test/jobFixtures'

const id = '13-4pass-2mm-ramp10-5deg'
const options = { thicknessMm: 13, profilePasses: 4, drillDepthMm: 2, rampProfile: '10mm-s-5deg' } as const
const dxf = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', 0, 'LWPOLYLINE', 8, 'PROFILE', 90, 4, 70, 1, 10, 0, 20, 0, 10, 180, 20, 0, 10, 180, 20, 100, 10, 0, 20, 100, 0, 'CIRCLE', 8, 'DRILL', 10, 30, 20, 30, 40, 3.175, 0, 'ENDSEC', 0, 'EOF', ''].join('\n')

it('generates the 13 mm counterpart to the 14 mm four-pass profile', async () => {
  const result = await generateDxfNc({ dxf, ...options })
  expect(result.settings).toMatchObject({ thicknessMm: 13, passDepthsMm: [3.35, 6.7, 10.05, 13.4], cutDepthMm: 13.4, drillDepthMm: 2, cutFeedMmPerMinute: 3000, rampFeedMmPerMinute: 600, rampDegrees: 5 })
  expect(result.filename).toBe('component-13mm-4pass-2mm-holes-ramp10-5deg.nc')
  expect(result.materialVariants.primaryProfile).toBe(id)
  expect(result.gcode.match(/\(Pass depth [\d.]+ mm\)/g)).toEqual([3.35, 6.7, 10.05, 13.4].map(depth => `(Pass depth ${depth} mm)`))
  expect(result.operations.find(operation => operation.kind === 'drill')?.depthMm).toBe(2)
  expect(simulateGCode(result.gcode)).toMatchObject({ errors: [], deepestCutMm: 13.4 })
  expect(result.materialVariants.profiles['14-4pass-2mm-ramp10-5deg']?.errors).toEqual([])
})

it('adds 13 mm to regenerated 14 mm bundles and selects it for files and jobs', async () => {
  const regenerated = await generateDxfNc({ dxf, thicknessMm: 14, profilePasses: 4, drillDepthMm: 2, rampProfile: '10mm-s-5deg' })
  const variant = regenerated.materialVariants.profiles[id]
  expect(variant?.errors).toEqual([])
  expect(simulateGCode(variant!.gcode).deepestCutMm).toBe(13.4)

  const part = parseComponent({ id: '20000000-0000-4000-8000-000000000001', name: 'Panel', sku: 'TEST', filename: regenerated.filename, gcode: regenerated.gcode, dxf, materialVariants: regenerated.materialVariants }, 'alice', testItem.id).part
  const selected = selectMaterialParts([part], { materialProfile: id, instances: [{ partId: part.id }] })
  expect(selected.errors).toEqual([])
  expect(selected.parts[0].originalFilename).toBe('component-13mm-4pass-2mm-holes-ramp10-5deg.nc')
  const request = parseJobRequest({ jobName: '13 mm', orderNumber: 'TEST', items: [{ itemId: testItem.id, quantity: 1 }], sheet: { widthMm: 500, heightMm: 400, material: 'Plywood', ...options, screwMarks: false } })
  const job = await generateJob(request, [testItem], [part])
  expect(job.sheet.materialProfile).toBe(id)
  expect(job.simulations[0].deepestCutMm).toBe(13.4)

  const older = structuredClone(regenerated.materialVariants)
  delete older.profiles[id]
  expect(materialVariantsSchema.safeParse(older).success).toBe(true)
  await expect(generateJob(request, [testItem], [{ ...part, metadata: { ...part.metadata, materialVariants: older } }])).rejects.toThrow('unavailable')
})

it.each([
  { thicknessMm: 13, profilePasses: undefined, drillDepthMm: undefined, rampProfile: undefined },
  { ...options, drillDepthMm: undefined },
  { ...options, rampProfile: undefined },
  { ...options, profilePasses: 3 },
  { ...options, drillDepthMm: 9 },
  { ...options, rampProfile: '20mm-s-5deg' },
])('rejects unsupported 13 mm combinations: %j', async input => {
  await expect(generateDxfNc({ dxf, ...input })).rejects.toMatchObject({ status: 400 })
})
