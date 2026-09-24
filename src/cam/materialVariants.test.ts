import { describe, expect, it } from 'vitest'
import { readDxf } from './dxf'
import { generateCam, materialPreset } from './generate'
import { generateMaterialVariants } from './materialVariants'
import { materialProfiles } from './materialProfiles'
import { createPartFromGCode } from '../gcode/importPart'
import { selectMaterialParts } from '../gcode/materialSelection'
import { validateSheet } from '../gcode/validator'
import { exportCombinedGCode, exportPhysicalSheetGCodes } from '../gcode/exporter'
import { simulateGCode } from '../gcode/simulator'
import { defaultProgramSettings } from '../gcode/programSettings'
import { buildTabMap } from '../printing/tabMap'
import { generateJob, parseJobRequest } from '../jobs/generateJob'
import { testItem } from '../test/jobFixtures'
import type { Sheet } from '../models/Sheet'
import type { CamSettings } from './types'

const rectangle = (x: number, y: number, w: number, h: number, layer = 'CUT_OUTER') => [0, 'LWPOLYLINE', 8, layer, 90, 4, 70, 1, 10, x, 20, y, 10, x + w, 20, y, 10, x + w, 20, y + h, 10, x, 20, y + h]
const circle = (x: number, y: number, r: number, layer = 'DRILL') => [0, 'CIRCLE', 8, layer, 10, x, 20, y, 40, r]
const dxf = (entities: (string | number)[][]) => [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', ...entities.flat(), 0, 'ENDSEC', 0, 'EOF', ''].join('\n')
export const variantDxf = dxf([rectangle(0, 0, 120, 100), circle(20, 20, 3.175)])
const settings: CamSettings = { thickness: 18, units: 'auto', operations: { f0: { tabs: 2 } }, programs: defaultProgramSettings }
const drawing = readDxf(variantDxf)
const bundle = generateMaterialVariants(drawing, settings)
const part = { ...createPartFromGCode('panel-18mm.nc', bundle.profiles['18'].gcode, variantDxf, testItem.id), id: 'panel', name: 'Panel', sku: 'PANEL', ownerId: 'alice' }
part.metadata.materialVariants = bundle
const sheet: Sheet = { name: 'Thickness test', width: 500, height: 400, spacing: 30, borderSpacing: 10, screwMarkingEnabled: false, safeZOverrideMm: 20, gcodeSettings: { ...defaultProgramSettings, safeZ: 20 }, instances: [0, 1].map(i => ({ id: `placed-${i}`, partId: part.id, sheetIndex: i, x: 10, y: 10, rotation: 0, locked: false })) }

describe('material variants', () => {
  it.each(materialProfiles)('generates $label with the same operations, tabs and account programs', profile => {
    const expected = generateCam(drawing, { ...settings, thickness: profile.thickness, drillDepthMm: profile.drillDepthMm, profilePasses: profile.thickness === 12 ? profile.profilePasses : undefined })
    const variant = bundle.profiles[profile.id]!
    expect(variant.errors).toEqual([])
    expect(variant.gcode).toBe(expected.gcode)
    expect(expected.operations.find(operation => operation.kind === 'outside')?.tabs).toHaveLength(2)
    expect(expected.operations.find(operation => operation.kind === 'drill')?.depthMm).toBe(materialPreset(profile.thickness, undefined, profile.drillDepthMm).drill)
    expect(simulateGCode(variant.gcode).deepestCutMm).toBe(materialPreset(profile.thickness).depth)
  })

  it.each(materialProfiles)('selects $label for every placed copy, export and tab map without modifying originals', profile => {
    const selectedSheet = { ...sheet, materialProfile: profile.id }
    const selection = selectMaterialParts([part], selectedSheet)
    expect(selection.errors).toEqual([])
    expect(selection.parts[0].gcode).toBe(bundle.profiles[profile.id]!.gcode)
    expect(selection.parts[0]).toMatchObject({ id: part.id, ownerId: 'alice', itemId: testItem.id, name: 'Panel', sku: 'PANEL' })
    expect(selectMaterialParts([part], selectedSheet).parts[0]).toBe(selection.parts[0])
    expect(validateSheet([part], selectedSheet).filter(issue => issue.level === 'error')).toEqual([])
    const combined = exportCombinedGCode([part], selectedSheet, defaultProgramSettings)
    expect(combined.errors).toEqual([])
    expect(simulateGCode(combined.gcode).deepestCutMm).toBe(materialPreset(profile.thickness).depth)
    for (const file of exportPhysicalSheetGCodes([part], selectedSheet, defaultProgramSettings)) {
      expect(file.errors).toEqual([])
      expect(simulateGCode(file.gcode).deepestCutMm).toBe(materialPreset(profile.thickness).depth)
    }
    expect(buildTabMap([part], selectedSheet).parts.every(part => part.tabs.length === 2)).toBe(true)
    expect(part.gcode).toBe(bundle.profiles['18'].gcode)
    expect(selectMaterialParts([part], sheet).parts[0]).toBe(part)
  })

  it('retains valid hinge variants and blocks thin-stock variants rather than dropping the hinge', () => {
    const hinge = readDxf(dxf([rectangle(0, 0, 300, 200), rectangle(80, 60, 120, 80, 'DOOR'), circle(110, 100, 17.5, 'HINGE')]))
    const variants = generateMaterialVariants(hinge, { ...settings, operations: {} })
    for (const id of ['6', '12', '12-2mm', '12-2pass'] as const) {
      expect(variants.profiles[id]!.gcode).toBe('')
      expect(variants.profiles[id]!.errors.join(' ')).toContain('hinge pockets')
    }
    for (const id of ['15', '18'] as const) expect(variants.profiles[id].errors).toEqual([])
    const hingePart = { ...part, metadata: { ...part.metadata, materialVariants: variants } }
    expect(exportCombinedGCode([hingePart], { ...sheet, materialProfile: '6' }).gcode).toBe('')
    expect(validateSheet([hingePart], { ...sheet, materialProfile: '6' }).some(issue => issue.message.includes('hinge pockets'))).toBe(true)
  })

  it('blocks old NC-only components at a selected thickness but preserves their original-NC workflow', () => {
    const legacy = { ...part, metadata: { ...part.metadata, materialVariants: undefined } }
    expect(exportCombinedGCode([legacy], sheet).errors).toEqual([])
    const selectedSheet = { ...sheet, materialProfile: '6' as const }
    expect(exportCombinedGCode([legacy], selectedSheet)).toMatchObject({ gcode: '', errors: [expect.stringContaining('Regenerate')] })
    expect(exportPhysicalSheetGCodes([legacy], selectedSheet).every(file => !file.gcode && file.errors.length)).toBe(true)
    expect(() => buildTabMap([legacy], selectedSheet)).toThrow('unavailable')
    expect(selectMaterialParts([legacy], { ...selectedSheet, instances: [] }).errors).toEqual([])
  })

  it('applies the requested material variant to API jobs and source hashes', async () => {
    const job = await generateJob(parseJobRequest({ jobName: 'Variant job', orderNumber: 'TEST', items: [{ itemId: testItem.id, quantity: 1 }], sheet: { widthMm: 500, heightMm: 400, material: 'Plywood', thicknessMm: 12, profilePasses: 2, screwMarks: false } }), [testItem], [part])
    expect(job.sheet.materialProfile).toBe('12-2pass')
    expect(job.parts[0].gcode).toBe(bundle.profiles['12-2pass'].gcode)
    expect(job.exported[0].gcode).toContain('Pass depth 6.1')
    expect(job.simulations[0].deepestCutMm).toBe(12.2)
    expect(job.manifest.cuts[0].deepestCutMm).toBe(12.2)
    const legacy = { ...part, metadata: { ...part.metadata, materialVariants: undefined } }
    await expect(generateJob(job.manifest.request, [testItem], [legacy])).rejects.toThrow('thickness is unavailable')
  })
})

it('uses 2 mm drills and one 12.2 mm contour pass for API jobs, without silently substituting old variants', async () => {
  const request = parseJobRequest({ jobName: 'Shallow drills', orderNumber: 'TEST', items: [{ itemId: testItem.id, quantity: 1 }], sheet: { widthMm: 500, heightMm: 400, material: 'Plywood', thicknessMm: 12, profilePasses: 1, drillDepthMm: 2, screwMarks: false } })
  const job = await generateJob(request, [testItem], [part])
  expect(job.sheet.materialProfile).toBe('12-2mm')
  expect(job.parts[0].gcode).toBe(bundle.profiles['12-2mm']?.gcode)
  expect(job.parts[0].originalFilename).toBe('panel-12mm-2mm-holes.nc')
  expect(job.exported[0].gcode).toContain('Z-2 F600')
  expect(job.exported[0].gcode).not.toContain('Z-4 F600')
  expect(job.simulations[0].deepestCutMm).toBe(12.2)
  const olderBundle = structuredClone(bundle)
  delete olderBundle.profiles['12-2mm']
  const legacy = { ...part, metadata: { ...part.metadata, materialVariants: olderBundle } }
  await expect(generateJob(request, [testItem], [legacy])).rejects.toThrow('unavailable')
  for (const patch of [{ thicknessMm: 6 }, { thicknessMm: 15 }, { thicknessMm: 18 }, { profilePasses: 2 }, { thicknessMm: undefined }]) {
    expect(() => parseJobRequest({ ...request, sheet: { ...request.sheet, ...patch } })).toThrow()
  }
})

it('preserves 9 mm holes when selecting the new profile for a complete API job', async () => {
  const request = parseJobRequest({ jobName: '9 mm holes', orderNumber: 'TEST', items: [{ itemId: testItem.id, quantity: 1 }], sheet: { widthMm: 500, heightMm: 400, material: 'Plywood', thicknessMm: 18, drillDepthMm: 9, screwMarks: false } })
  const job = await generateJob(request, [testItem], [part])
  expect(job.sheet.materialProfile).toBe('18-9mm')
  expect(job.parts[0].gcode).toBe(bundle.profiles['18-9mm']?.gcode)
  expect(job.exported[0].gcode).toContain('Z-9 F600')
  expect(job.simulations[0].deepestCutMm).toBe(18.4)
  const oldBundle = structuredClone(bundle)
  delete oldBundle.profiles['18-9mm']
  const legacy = { ...part, metadata: { ...part.metadata, materialVariants: oldBundle } }
  await expect(generateJob(request, [testItem], [legacy])).rejects.toThrow('unavailable')
  expect(() => parseJobRequest({ ...request, sheet: { ...request.sheet, thicknessMm: 12 } })).toThrow()
})
