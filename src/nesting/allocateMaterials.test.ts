import { describe, expect, it } from 'vitest'
import { addItemToSheet } from './addItemToSheet'
import { allocateMaterials } from './allocateMaterials'
import { addition, hex, materialPart, materialSheet, natural } from '../test/materialFixtures'
import { physicalSheet, setSheetMaterial, sheetMaterial, stockErrors } from '../models/stockMaterial'
import { exportCombinedGCode, exportPhysicalSheetGCodes } from '../gcode/exporter'
import { buildExportSnapshot } from '../machine/exportSnapshot'
import { newProductionJob, planWaitingSheets, replanWorkspace, sheetSignature, updateProductionSheet } from '../jobs/production'
import { sheetGCodeFilename } from '../gcode/filenames'
import { buildPartLabels } from '../labels/partLabels'
import { generateJob, parseJobRequest } from '../jobs/generateJob'
import { testItem, testRequest } from '../test/jobFixtures'

describe('material allocation and machining', () => {
  it('honours material and preset selected on an empty physical sheet', () => {
    const part = materialPart('panel')
    const sheet = setSheetMaterial({ ...materialSheet(), stockMaterial: undefined, materialProfile: undefined }, 0, { stockMaterial: natural, materialProfile: '13-4pass-2mm-ramp10-5deg' })
    const next = addItemToSheet(testItem, [part], sheet, 'alice', 0)
    expect(sheetMaterial(next,0)).toMatchObject({ stockMaterial: natural, materialProfile: '13-4pass-2mm-ramp10-5deg' })
    expect(exportPhysicalSheetGCodes([part],next)[0].gcode).toContain('Z-13.4')
  })
  it('separates thickness, finish and cutting face while respecting part overrides', () => {
    const parts = [materialPart('natural'), { ...materialPart('hex'), stockMaterial: hex, cutSide: 'pattern' as const },
      { ...materialPart('back', hex), cutSide: 'non-pattern' as const }, materialPart('18mm', { ...natural, thicknessMm: 18 })]
    const sheet = allocateMaterials(parts, materialSheet(), parts.map(p => addition(p.id)))
    expect(new Set(sheet.instances.map(i => i.sheetIndex)).size).toBe(4)
    expect(stockErrors(parts, sheet)).toEqual([])
    expect(sheetMaterial(sheet, sheet.instances[1].sheetIndex).stockMaterial).toEqual(hex)
    expect(sheetMaterial(sheet, sheet.instances[3].sheetIndex).materialProfile).toBe('18')
    expect(buildPartLabels(parts, [testItem], sheet).map(l => l.material)).toEqual(['12 mm Plywood · Natural', '12 mm Plywood · Black Hex', '12 mm Plywood · Black Hex', '18 mm Plywood · Natural'])
    expect(sheetGCodeFilename('job-sheet-2', parts, sheet, sheet.instances[1].sheetIndex)).toBe('job-sheet-2-12-mm-plywood-black-hex-pattern-side-up.nc')
  })
  it('ignores pattern faces while retaining stock thickness and finish separation', () => {
    const parts = [{ ...materialPart('front', hex), cutSide: 'pattern' as const },
      { ...materialPart('back', hex), cutSide: 'non-pattern' as const }, materialPart('natural')]
    const sheet = allocateMaterials(parts, { ...materialSheet(), ignorePatternSides: true }, parts.map(p => addition(p.id)))
    expect(sheet.instances[0].sheetIndex).toBe(sheet.instances[1].sheetIndex)
    expect(sheet.instances[2].sheetIndex).not.toBe(sheet.instances[0].sheetIndex)
    expect(stockErrors(parts, sheet)).toEqual([])
    expect(exportPhysicalSheetGCodes(parts, sheet).flatMap(f => f.errors)).toEqual([])
    expect(buildPartLabels(parts, [testItem], sheet).every(l => l.cutSide === 'either')).toBe(true)
  })
  it('keeps deferred parts exactly once and later allocates them without moving existing cuts', () => {
    const parts = [materialPart('natural'), materialPart('hex', hex)]
    const additions = parts.map(p => addition(p.id))
    const partial = allocateMaterials(parts, materialSheet(), additions, 0, true)
    expect(partial.instances).toHaveLength(1)
    expect(partial.pendingParts).toEqual([additions[1]])
    const before = partial.instances[0]
    const complete = allocateMaterials(parts, { ...partial, pendingParts: [] }, partial.pendingParts!)
    expect(complete.pendingParts).toEqual([])
    expect(new Set(complete.instances.map(i => i.id)).size).toBe(2)
    expect(complete.instances[0]).toEqual(before)
  })
  it('uses the 13 mm preset on actual 12 mm stock and exports each sheet at its own depth', async () => {
    const parts = [materialPart('12mm'), materialPart('18mm', { ...natural, thicknessMm: 18 })]
    const sheet = allocateMaterials(parts, { ...materialSheet(), materialProfile: '13-4pass-2mm-ramp10-5deg' }, parts.map(p => addition(p.id)))
    const files = exportPhysicalSheetGCodes(parts, sheet)
    expect(files.flatMap(f => f.errors)).toEqual([])
    expect(files[0].gcode).toContain('Z-13.4')
    expect(files[0].gcode).not.toContain('Z-18.4')
    expect(files[1].gcode).toContain('Z-18.4')
    expect(exportCombinedGCode(parts, sheet).gcode).toContain('Z-18.4')
    const snapshot = await buildExportSnapshot({ parts, sheet, items: [testItem], mode: 'sheets', summary: { exportWarnings: [] }, files: files.map((f,i) => ({ filename: `${i}.nc`, gcode: f.gcode, simulation: { estimatedSeconds: 1 } })) })
    expect(snapshot.sheets[0].materialSetup).toMatchObject({ stockMaterial: natural, materialProfile: '13-4pass-2mm-ramp10-5deg' })
    expect(snapshot.sheets[1].materialSetup?.stockMaterial?.thicknessMm).toBe(18)
  })
  it('exports the same component on two presets without reusing the first sheet program', () => {
    const part = materialPart('panel'), setup = { stockMaterial: natural, materialProfile: '13-4pass-2mm-ramp10-5deg' as const }
    const sheet = allocateMaterials([part], materialSheet(), [addition(part.id), { ...addition(part.id), materialSetup: setup }])
    expect(exportPhysicalSheetGCodes([part], sheet).map(f => /Z-13.4/.test(f.gcode))).toEqual([false, true])
  })
  it('blocks wrong stock and unavailable programs without mutating the job', () => {
    const part = materialPart('panel'), original = materialSheet(), before = structuredClone(original)
    const sheet = allocateMaterials([part], original, [addition(part.id)])
    const wrong = setSheetMaterial(sheet, 0, { ...sheetMaterial(sheet,0), stockMaterial: hex })
    expect(exportPhysicalSheetGCodes([part], wrong)[0].errors.join(' ')).toContain('requires 12 mm')
    const missing = { ...part, defaultStockMaterial: { ...natural, thicknessMm: 9 } }
    expect(() => allocateMaterials([missing], original, [addition(part.id)])).toThrow('no cutting preset')
    expect(original).toEqual(before)
  })
  it('retains the exact recut material and never fills a closed sheet', () => {
    const part = materialPart('panel'), start = allocateMaterials([part], materialSheet(), [addition(part.id)])
    const before = sheetSignature(start, 0)
    const replacement = { ...addition(part.id), materialSetup: sheetMaterial(start,0), recutId: 'recut' }
    const next = allocateMaterials([part], { ...start, unavailableSheetIndices: [0] }, [replacement])
    expect(next.instances[1].sheetIndex).not.toBe(0)
    expect(next.instances[1].materialSetup).toEqual(replacement.materialSetup)
    expect(sheetSignature(next,0)).toBe(before)
    let job = newProductionJob(next)
    job.sheets[0] = { stage: 'cut', signature: before, runId: 'run' }
    job = planWaitingSheets(job, [part])
    expect(sheetSignature(job.sheet,0)).toBe(before)
    expect(() => updateProductionSheet(job, setSheetMaterial(job.sheet,1,{ ...sheetMaterial(job.sheet,1), materialProfile: '13-4pass-2mm-ramp10-5deg' }))).not.toThrow()
    expect(() => updateProductionSheet(job, setSheetMaterial(job.sheet,0,{ stockMaterial: hex }))).toThrow('fixed')
  })
  it('combines waiting jobs by stock without losing order identity or changing cut sheets', () => {
    const parts = [materialPart('panel'), materialPart('hex', hex)]
    const first = newProductionJob(allocateMaterials(parts, materialSheet(), [addition('panel'), addition('hex')]))
    first.sheets[0] = { stage: 'cut' }
    const second = newProductionJob(allocateMaterials(parts, materialSheet(), [{ ...addition('hex'), orderName: 'Order 2', orderKey: 'shop/2' }, addition('panel')]))
    const before = sheetSignature(first.sheet,0)
    const result = replanWorkspace({ activeId: first.id, jobs: [first, second] }, parts)
    expect(sheetSignature(result.jobs[0].sheet,0)).toBe(before)
    expect(result.jobs[0].sheet.instances).toHaveLength(4)
    expect(stockErrors(parts,result.jobs[0].sheet)).toEqual([])
    expect(result.jobs[0].sheet.instances.find(i => i.orderKey === 'shop/2')?.orderName).toBe('Order 2')
    expect(physicalSheet(result.jobs[0].sheet,0).instances).toHaveLength(1)
  })
  it('applies the same stock rules through API job generation', async () => {
    const parts = [materialPart('panel'), materialPart('hex', hex)]
    const result = await generateJob(parseJobRequest({ ...testRequest, sheet: { ...testRequest.sheet, widthMm: 400, heightMm: 400, stockMaterial: natural, thicknessMm: 13, profilePasses: 4, drillDepthMm: 2, rampProfile: '10mm-s-5deg' } }), [testItem], parts)
    expect(result.manifest.sheets).toHaveLength(2)
    expect(result.manifest.sheets[0].materialSetup?.materialProfile).toBe('13-4pass-2mm-ramp10-5deg')
    expect(result.manifest.cuts.filter(c => c.deepestCutMm === 13.4)).toHaveLength(2)
    expect(result.manifest.sheets[1].materialSetup?.stockMaterial).toEqual(hex)
  })
})
