import { describe, expect, it } from 'vitest'
import type { Sheet } from '../models/Sheet'
import type { Part } from '../models/Part'
import { sheetCutSide } from '../models/cutSide'
import { autoNest } from './nestingEngine'
import { addItemToSheet } from './addItemToSheet'
import { validateSheet } from '../gcode/validator'
import { exportCombinedGCode, exportPhysicalSheetGCodes } from '../gcode/exporter'
import { generateJob, parseJobRequest } from '../jobs/generateJob'
import { buildExportSnapshot } from '../machine/exportSnapshot'
import { buildPartLabels } from '../labels/partLabels'
import { selectMaterialParts } from '../gcode/materialSelection'
import { materialProfiles, materialVariantsSchema } from '../cam/materialProfiles'
import { testItem, testParts, testRequest } from '../test/jobFixtures'

const parts: Part[] = testParts.map((part, index) => ({ ...part, cutSide: index ? 'non-pattern' : 'pattern' }))
const sheet = (components = parts): Sheet => ({
  name: 'Patterned plywood', width: 500, height: 500, spacing: 10, borderSpacing: 10,
  screwMarkingEnabled: false,
  gcodeSettings: { startGcode: 'G21\nG17\nG90', spindleStartGcode: 'S18000\nM03', endGcode: 'M05\nM30', safeZ: 20 },
  instances: components.map((part, index) => ({ id: `i${index}`, partId: part.id, sheetIndex: 0, x: 10 + index * 100, y: 10, rotation: 0, locked: false })),
})

describe('component cutting faces', () => {
  it('separates opposite faces, lets either-side parts share stock, and preserves instance identity', () => {
    const flexible = { ...testParts[0], id: 'flexible' }
    const components = [...parts, flexible]
    const input = sheet(components)
    const nested = { ...input, instances: autoNest(components, input) }
    expect(nested.instances.map(instance => instance.sheetIndex)).toEqual([0, 1, 0])
    expect(nested.instances.map(instance => instance.id)).toEqual(input.instances.map(instance => instance.id))
    expect(sheetCutSide(components, nested, 0)).toBe('pattern')
    expect(sheetCutSide(components, nested, 1)).toBe('non-pattern')
    expect(validateSheet(components, nested).filter(issue => issue.level === 'error')).toEqual([])
    expect(input.instances.every(instance => instance.sheetIndex === 0)).toBe(true)
  })

  it('retains the old nesting behaviour for legacy parts without a face requirement', () => {
    expect(autoNest(testParts, sheet(testParts)).map(instance => instance.sheetIndex)).toEqual([0, 0])
    expect(sheetCutSide(testParts, sheet(testParts), 0)).toBe('either')
  })

  it('respects locked stock faces and rejects conflicting locked placements', () => {
    const input = sheet()
    input.instances[0].locked = true
    expect(autoNest(parts, input)[0]).toEqual(input.instances[0])
    expect(autoNest(parts, input)[1].sheetIndex).toBe(1)
    input.instances[1].locked = true
    expect(() => autoNest(parts, input)).toThrow('mixes pattern-side-up and non-pattern-side-up')
  })

  it('adds a complete mixed-face item without moving existing stock', () => {
    const input = sheet([parts[0]])
    input.instances[0].id = 'existing'
    const added = addItemToSheet(testItem, parts, input, 'operator', 0)
    expect(added.instances[0]).toMatchObject(input.instances[0])
    expect(added.instances.map(instance => instance.sheetIndex)).toEqual([0, 0, 1])
    expect(sheetCutSide(parts, added, 0)).toBe('pattern')
    expect(sheetCutSide(parts, added, 1)).toBe('non-pattern')
  })

  it('blocks both export paths and machine snapshots when manual placements mix faces', async () => {
    const input = sheet()
    expect(validateSheet(parts, input).some(issue => issue.level === 'error' && issue.message.includes('mixes'))).toBe(true)
    expect(exportCombinedGCode(parts, input)).toMatchObject({ gcode: '', errors: [expect.stringContaining('mixes')] })
    expect(exportPhysicalSheetGCodes(parts, input)[0]).toMatchObject({ gcode: '', errors: [expect.stringContaining('mixes')] })
    await expect(buildExportSnapshot({ mode: 'sheets', parts, sheet: input, files: [], summary: { exportWarnings: [] } })).rejects.toThrow('mixes')
  })

  it('rejects unknown face values from project backups instead of silently treating them as unrestricted', () => {
    const invalid = [{ ...parts[0], cutSide: 'bad-value' as Part['cutSide'] }]
    expect(() => autoNest(invalid, sheet(invalid))).toThrow('Unknown component cutting side')
    expect(exportCombinedGCode(invalid, sheet(invalid)).gcode).toBe('')
  })

  it('retains cutting faces when selecting a different thickness program', () => {
    const part: Part = { ...parts[0], metadata: { ...parts[0].metadata, materialVariants: materialVariantsSchema.parse({
      version: 1, primaryProfile: '18', profiles: Object.fromEntries(materialProfiles.map(profile => [profile.id, { gcode: `${parts[0].gcode}\n(12 mm variant)`, errors: [], warnings: [] }])),
    }) } }
    const selected = selectMaterialParts([part], { materialProfile: '12', instances: sheet([part]).instances })
    expect(selected.errors).toEqual([])
    expect(selected.parts[0].cutSide).toBe('pattern')
    expect(selected.parts[0].gcode).toContain('12 mm variant')
  })

  it('carries the face through jobs, NC sheet changes, labels and immutable machine snapshots', async () => {
    const request = parseJobRequest({ ...testRequest, items: [{ sku: testItem.sku, quantity: 1 }], sheet: { ...testRequest.sheet, widthMm: 500, heightMm: 500, screwMarks: false } })
    const job = await generateJob(request, [testItem], parts)
    expect(job.manifest.sheets.map(value => value.cutSide)).toEqual(['pattern', 'non-pattern'])
    expect(job.manifest.cuts.map(value => value.cutSide)).toEqual(['pattern', 'non-pattern'])
    expect(job.exported[0].gcode).toContain('(Load material: Pattern side up)')
    expect(job.exported[1].gcode).toContain('(Load material: Non-pattern side up)')
    expect(exportCombinedGCode(parts, job.sheet).gcode).toContain('Load physical sheet 2: Non-pattern side up')
    expect(buildPartLabels(parts, [testItem], job.sheet).map(label => label.cutSide)).toEqual(['pattern', 'non-pattern'])
    const snapshot = await buildExportSnapshot({ mode: 'sheets', parts, sheet: job.sheet, files: job.exported.map((file, i) => ({ filename: `sheet-${i + 1}.nc`, gcode: file.gcode, simulation: job.simulations[i] })), summary: { exportWarnings: [] } })
    expect(snapshot.sheets.map(value => value.cutSide)).toEqual(['pattern', 'non-pattern'])
  })
})
