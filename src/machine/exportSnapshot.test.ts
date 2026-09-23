import { describe, expect, it } from 'vitest'
import { buildExportSnapshot, ncHash } from './exportSnapshot'
import { createPartFromGCode } from '../gcode/importPart'
import { exportCombinedGCode, exportPhysicalSheetGCodes } from '../gcode/exporter'
import { defaultProgramSettings } from '../gcode/programSettings'
import type { Sheet } from '../models/Sheet'

const source = 'G21\nG90\nG00 X0 Y0 Z20\n(No. 1 Part machining: Outer)\nG01 Z-12.2 F600\nG01 X40 F3000\n(Tab 1)\nG01 Z-6.2\nG01 X50\nG01 Z-12.2\nG01 X100\nG01 Y80\nG01 X0\nG01 Y0\nG00 Z20\nM30'
function fixture() {
  const part = createPartFromGCode('side.nc', source)
  const sheet: Sheet = { name: 'Rack', orderNumber: '1007', material: 'Plywood', width: 1220, height: 1220, spacing: 30, borderSpacing: 10, screwMarkingEnabled: true, safeZOverrideMm: 20, gcodeSettings: { ...defaultProgramSettings, safeZ: 5 }, instances: [
    { id: 'one', partId: part.id, partNumber: 7, sheetIndex: 0, x: 30, y: 30, rotation: 0, locked: false },
    { id: 'two', partId: part.id, partNumber: 8, sheetIndex: 1, x: 230, y: 300, rotation: 90, locked: false },
  ] }
  return { part, sheet }
}
describe('immutable machine export snapshots', () => {
  it('keeps exact NC bytes, rotated tabs, sheet numbering, safe Z and screw marks without retaining catalogue parts', async () => {
    const { part, sheet } = fixture()
    const result = exportCombinedGCode([part], sheet)
    expect(result.errors).toEqual([])
    const snapshot = await buildExportSnapshot({ mode: 'combined', parts: [part], sheet, files: [{ filename: 'rack.nc', gcode: result.gcode, simulation: { estimatedSeconds: 123 } }], summary: { deepestCutMm: 12.2, exportWarnings: [] } })
    expect(snapshot.files[0].gcode).toBe(result.gcode)
    expect(snapshot.files[0].sha256).toBe(await ncHash(result.gcode))
    expect(snapshot.safeZ).toBe(20)
    expect(snapshot.deepestCutMm).toBe(12.2)
    expect(snapshot.map.parts.map(part => part.number)).toEqual(['P007', 'P008'])
    expect(snapshot.map.parts.map(part => part.tabs.length)).toEqual([1, 1])
    expect(snapshot.map.parts[0].tabs[0].center).toEqual({ x: 75, y: 30 })
    expect(snapshot.map.parts[1].tabs[0].center).toEqual({ x: 310, y: 345 })
    expect(snapshot.sheets[0].screws.length).toBeGreaterThan(0)
    expect(result.gcode).toContain(`G00 X${snapshot.sheets[0].maxX} Y${snapshot.sheets[0].maxY}`)
    expect(snapshot.thickness).toContain('verify stock')
    const saved = JSON.stringify(snapshot)
    sheet.instances[0].x = 900
    sheet.gcodeSettings.startGcode = 'changed'
    part.gcode = 'changed'
    expect(JSON.stringify(snapshot)).toBe(saved)
    expect(snapshot).not.toHaveProperty('parts')
  })
  it('associates separate files with physical sheets and rejects incomplete file sets', async () => {
    const { part, sheet } = fixture()
    const results = exportPhysicalSheetGCodes([part], sheet)
    const input = { mode: 'sheets' as const, parts: [part], sheet, files: results.map(result => ({ filename: `rack-${result.sheetIndex + 1}.nc`, gcode: result.gcode, simulation: { estimatedSeconds: 20 } })), summary: { exportWarnings: [] } }
    const snapshot = await buildExportSnapshot(input)
    expect(snapshot.files.map(file => file.filename)).toEqual(['rack-1.nc', 'rack-2.nc'])
    expect(snapshot.files[1].gcode).toContain('(Part number: P008)')
    expect(snapshot.files[1].gcode).not.toContain('(Part number: P007)')
    await expect(buildExportSnapshot({ ...input, files: input.files.slice(0, 1) })).rejects.toThrow('file count')
  })
})
