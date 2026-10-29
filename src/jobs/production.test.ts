import { describe, expect, it } from 'vitest'
import { newProductionJob, planWaitingSheets, replanWorkspace, sheetSignature, sheetNeedsExport, changeSheetStage, updateProductionSheet, waitingExportSheet } from './production'
import { autoNest } from '../nesting/nestingEngine'
import { exportPhysicalSheetGCodes } from '../gcode/exporter'
import { sheetGCodeFilename } from '../gcode/filenames'
import { testParts } from '../test/jobFixtures'
import type { Sheet } from '../models/Sheet'

function job() {
  const sheet: Sheet = { name: 'Legacy', width: 500, height: 500, spacing: 10, borderSpacing: 10, material: 'Ply', materialProfile: undefined, screwMarkingEnabled: false,
    gcodeSettings: { startGcode: 'G21 G90', spindleStartGcode: 'S18000 M03', endGcode: 'M05\nM30', safeZ: 20 },
    instances: testParts.map((part, i) => ({ id: `part-${i}`, partId: part.id, sheetIndex: i, x: 20, y: 20, rotation: 0, locked: false, partNumber: i + 1 })),
  }
  return newProductionJob(sheet)
}
function exported() {
  const value = job()
  value.sheets = Object.fromEntries([0, 1].map(i => [i, { stage: 'waiting' as const, runId: 'export-1', signature: sheetSignature(value.sheet, i) }]))
  return value
}

describe('production sheet workflow', () => {
  it('keeps cutting and cut sheets fixed, and never nests additions onto their spare space', () => {
    let value = changeSheetStage(exported(), 0, 'cutting')
    const original = value.sheet.instances[0]
    const result = planWaitingSheets(value, testParts)
    expect(result.sheet.instances.find(i => i.id === original.id)).toEqual(original)
    expect(result.sheet.instances.filter(i => i.sheetIndex === 0)).toEqual([original])
    value = changeSheetStage(value, 0, 'cut')
    expect(() => changeSheetStage(value, 0, 'waiting')).toThrow('cannot return')
    const nested = autoNest(testParts, { ...value.sheet, unavailableSheetIndices: [0] })
    expect(nested[0]).toEqual(original)
    expect(nested[1].sheetIndex).toBe(1)
    expect(waitingExportSheet(value).instances).toEqual([value.sheet.instances[1]])
  })
  it('rejects edits to cut geometry and stock settings but allows waiting-sheet changes', () => {
    const value = changeSheetStage(exported(), 0, 'cut')
    expect(() => updateProductionSheet(value, { ...value.sheet, width: 600 })).toThrow('fixed')
    expect(() => updateProductionSheet(value, { ...value.sheet, instances: value.sheet.instances.slice(1) })).toThrow('fixed')
    const updated = updateProductionSheet(value, { ...value.sheet, instances: value.sheet.instances.map(i => i.sheetIndex === 1 ? { ...i, x: 100 } : i) })
    expect(sheetNeedsExport(updated, 0)).toBe(false)
    expect(sheetNeedsExport(updated, 1)).toBe(true)
    expect(() => changeSheetStage(updated, 1, 'cutting')).toThrow('Export the latest')
  })
  it('re-packs compatible waiting jobs together while preserving order identity, cut parts and different stock', () => {
    const first = changeSheetStage(exported(), 0, 'cut')
    first.sheet.orderNumber = 'ORDER-1'
    const second = job(); second.sheet.orderNumber = 'ORDER-2'; second.sheet.instances = second.sheet.instances.map(i => ({ ...i, id: `second-${i.id}` }))
    const different = job(); different.sheet.material = 'Other stock'
    const result = replanWorkspace({ activeId: first.id, jobs: [first, second, different] }, testParts)
    expect(result.jobs[0].sheet.instances.filter(i => i.sheetIndex === 0)).toEqual([first.sheet.instances[0]])
    expect(result.jobs[0].sheet.instances).toHaveLength(4)
    expect(result.jobs[0].sheet.instances.filter(i => i.orderName === 'ORDER-2')).toHaveLength(2)
    expect(result.jobs[1].sheet.instances).toEqual([])
    expect(result.jobs[2].sheet.instances).toHaveLength(2)
    expect(new Set(result.jobs[0].sheet.instances.map(i => i.partNumber)).size).toBe(4)
  })
  it('exports only occupied waiting indices and adds each actual cutting face to the filename', () => {
    const parts = testParts.map((part, i) => ({ ...part, cutSide: i ? 'non-pattern' as const : 'pattern' as const }))
    const value = changeSheetStage(exported(), 0, 'cut')
    const sheet = waitingExportSheet(value)
    const files = exportPhysicalSheetGCodes(parts, sheet)
    expect(files.map(file => file.sheetIndex)).toEqual([1])
    expect(sheetGCodeFilename('2026-10-29-001-sheet-2', parts, sheet, 1)).toBe('2026-10-29-001-sheet-2-non-pattern-side-up.nc')
    expect(sheetGCodeFilename('job-sheet-1', parts, value.sheet, 0)).toBe('job-sheet-1-pattern-side-up.nc')
    expect(sheetGCodeFilename('job', parts, value.sheet)).toBe('job-pattern-and-non-pattern-sides.nc')
    expect(sheetGCodeFilename('job', testParts, value.sheet)).toBe('job.nc')
  })
})
