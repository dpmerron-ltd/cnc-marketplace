import { describe, expect, it } from 'vitest'
import { buildPartLabels, labelPageLayout, numberSheetParts } from './partLabels'
import { createPartFromGCode } from '../gcode/importPart'
import { exportCombinedGCode, exportPhysicalSheetGCodes } from '../gcode/exporter'
import { autoNest } from '../nesting/nestingEngine'
import { parseGCode } from '../gcode/parser'
import type { Sheet } from '../models/Sheet'

const part = createPartFromGCode('side.nc', 'G21\nG90\nG00 X0 Y0 Z5\nG01 Z-2 F300\nG01 X50 Y0 F1000\nG01 X50 Y50\nG00 Z5\nM30')
const sheet: Sheet = {
  name: 'Camperlocker', orderNumber: 'ORD-123', material: '18 mm plywood', width: 1220, height: 1220, spacing: 10, borderSpacing: 10,
  instances: [0, 1].map(index => ({ id: `copy-${index}`, partId: part.id, sheetIndex: index, x: 10, y: 10, rotation: 0, locked: false })),
  screwMarkingEnabled: false, safeZOverrideMm: 20,
  gcodeSettings: { startGcode: 'G21\nG17\nG90\nG94', spindleStartGcode: 'S18000\nM03', endGcode: 'M05\nM30', safeZ: 5 },
}

describe('part labels', () => {
  it('numbers legacy instances without changing the input', () => {
    const numbered = numberSheetParts(sheet)
    expect(numbered.instances.map(instance => instance.partNumber)).toEqual([1, 2])
    expect(numbered.nextPartNumber).toBe(3)
    expect(sheet.instances[0].partNumber).toBeUndefined()
    expect(numberSheetParts(numbered)).toEqual(numbered)
  })

  it('keeps numbers through moves, nesting and deletion, without recycling removed numbers', () => {
    const numbered = numberSheetParts(sheet)
    const nested = numberSheetParts({ ...numbered, instances: autoNest([part], numbered) })
    for (const instance of nested.instances) expect(instance.partNumber).toBe(numbered.instances.find(old => old.id === instance.id)?.partNumber)
    const changed = numberSheetParts({ ...numbered, instances: [{ ...numbered.instances[1], x: 200 }, { ...sheet.instances[0], id: 'new-copy' }] })
    expect(changed.instances.map(instance => instance.partNumber)).toEqual([2, 3])
    const cleared = numberSheetParts({ ...changed, instances: [] })
    expect(numberSheetParts({ ...cleared, instances: [sheet.instances[0]] }).instances[0].partNumber).toBe(4)
  })

  it('repairs duplicate and invalid imported numbers', () => {
    const repaired = numberSheetParts({ ...sheet, nextPartNumber: NaN, instances: sheet.instances.map(instance => ({ ...instance, partNumber: 7 })) })
    expect(repaired.instances.map(instance => instance.partNumber)).toEqual([7, 8])
  })

  it('matches label numbers across combined and individual sheet exports', () => {
    const numbered = numberSheetParts(sheet)
    const labels = buildPartLabels([part], [], { ...numbered, instances: [...numbered.instances].reverse() })
    expect(labels.map(label => [label.partNumber, label.sheetNumber, label.cutOrder])).toEqual([['P001', 1, 1], ['P002', 2, 2]])
    expect(labels[0]).toMatchObject({ job: 'Camperlocker', order: 'ORD-123', material: '18 mm plywood', component: part.name, sku: part.sku })
    const combined = exportCombinedGCode([part], numbered)
    expect(combined.errors).toEqual([])
    const physical = exportPhysicalSheetGCodes([part], numbered)
    labels.forEach((label, index) => {
      expect(combined.gcode).toContain(`(Part number: ${label.partNumber})`)
      expect(physical[index].gcode).toContain(`(Part number: ${label.partNumber})`)
    })
  })

  it('does not alter executable G-code and prevents metadata from injecting commands', () => {
    const original = exportCombinedGCode([part], sheet)
    const changed = exportCombinedGCode([part], { ...numberSheetParts(sheet), name: 'Job)\nG00 Z-100\n(', orderNumber: 'Order)\nM03\n(', material: 'Different', instances: sheet.instances.map((instance, index) => ({ ...instance, partNumber: index + 10 })) })
    const commands = (gcode: string) => parseGCode(gcode).lines.filter(line => line.words.length).map(line => line.words)
    expect(commands(changed.gcode)).toEqual(commands(original.gcode))
  })

  it('rejects labels for missing components', () => {
    expect(() => buildPartLabels([], [], sheet)).toThrow('missing')
  })

  it('uses exact custom dimensions and calculates A4 pagination', () => {
    expect(labelPageLayout({ width: 50, height: 25, format: 'single' })).toMatchObject({ pageWidth: 50, pageHeight: 25, perPage: 1, margin: 0 })
    expect(labelPageLayout({ width: 50, height: 25, format: 'a4' })).toMatchObject({ columns: 3, rows: 10, perPage: 30 })
    for (const width of [0, NaN, Infinity, 191]) expect(() => labelPageLayout({ width, height: 25, format: 'single' })).toThrow('Label size')
    expect(() => labelPageLayout({ width: 50, height: 0, format: 'single' })).toThrow('Label size')
  })
})
