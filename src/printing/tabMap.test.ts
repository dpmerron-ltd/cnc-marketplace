import { describe, expect, it } from 'vitest'
import { buildTabMap, locatePartTabs } from './tabMap'
import { createPartFromGCode } from '../gcode/importPart'
import { generateCam } from '../cam/generate'
import type { CamDrawing, CamSettings } from '../cam/types'
import type { Sheet } from '../models/Sheet'
import { defaultProgramSettings } from '../gcode/programSettings'
import { transformLocalPoint } from '../gcode/transform'
import { exportCombinedGCode } from '../gcode/exporter'

const rectangle = (x: number, y: number, width: number, height: number) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }]
const drawing: CamDrawing = { units: 'mm', errors: [], warnings: [], features: [
  { id: 'f0', name: 'Outer', kind: 'outside', layer: 'PROFILE', closed: true, points: rectangle(0, 0, 300, 200) },
  { id: 'f1', name: 'Door', kind: 'inside', door: true, layer: 'DOOR', closed: true, points: rectangle(60, 60, 150, 80) },
] }
const preset: CamSettings = { thickness: 18, units: 'mm', operations: {} }
const legacy = 'G21\nG90\nG00 X0 Y0 Z20\n(No. 1 Part machining: Outer)\nG01 Z-18.4 F600\nG01 X40 F3000\nG00 Z-12.4\nG01 X56\nG01 X76 Z-18.4\nG01 X100\nG01 Y80\nG01 X0\nG01 Y20\nG00 Z-12.4\nG01 Y4\nG00 Z20\nM30'
const part = createPartFromGCode('legacy.nc', legacy)
const sheet: Sheet = { name: 'Test job', orderNumber: 'ORDER-42', width: 1220, height: 1220, spacing: 30, borderSpacing: 10, screwMarkingEnabled: false, safeZOverrideMm: 20, gcodeSettings: { ...defaultProgramSettings, safeZ: 20 }, instances: [{ id: 'copy-1', partId: part.id, partNumber: 7, sheetIndex: 0, x: 10, y: 20, rotation: 0, locked: false }] }

describe('Printable tab locations', () => {
  it.each([{ thickness: 12 }, { thickness: 12, profilePasses: 2 }, { thickness: 15 }, { thickness: 18 }] as const)('matches explicit CAM tabs for %j without duplicate pass locations', settings => {
    const cam = generateCam(drawing, { ...preset, ...settings })
    expect(cam.errors).toEqual([])
    const mapped = locatePartTabs(createPartFromGCode('generated.nc', cam.gcode))
    expect(mapped.tabs).toHaveLength(cam.operations.reduce((count, op) => count + op.tabs.length, 0))
    expect(mapped.tabs.every(tab => !tab.inferred)).toBe(true)
    for (const expected of cam.operations.flatMap(op => op.tabs)) {
      expect(mapped.tabs.some(tab => Math.hypot(tab.points[0].x - expected.start.x, tab.points[0].y - expected.start.y) < 0.001 && Math.hypot(tab.points.at(-1)!.x - expected.end.x, tab.points.at(-1)!.y - expected.end.y) < 0.001)).toBe(true)
    }
    expect(mapped.warnings).toEqual([])
  })
  it('finds imported rapid tab lifts, including the final tab before retract', () => {
    const result = locatePartTabs(part)
    expect(result.tabs.map(tab => tab.center)).toEqual([{ x: 48, y: 0 }, { x: 0, y: 12 }])
    expect(result.tabs.every(tab => tab.inferred && tab.z === -12.4)).toBe(true)
    expect(result.warnings.join()).toContain('inferred')
  })
  it.each([0, 37, 90, 143.125, 180, 270] as const)('transforms repeated parts and tabs at %s degrees using the export placement transform', rotation => {
    const placed = { ...sheet, instances: [sheet.instances[0], { ...sheet.instances[0], id: 'copy-2', partNumber: 23, sheetIndex: 1, x: 350, y: 400, rotation }] }
    const before = exportCombinedGCode([part], placed).gcode
    const result = buildTabMap([part], placed)
    expect(result.sheetCount).toBe(2)
    expect(result.parts.map(p => p.number)).toEqual(['P007', 'P023'])
    expect(result.parts[1].tabs[0].center).toEqual(transformLocalPoint(part, placed.instances[1], { x: 48, y: 0 }))
    expect(result.parts[0].tabs[0].center).toEqual({ x: 58, y: 20 })
    expect(exportCombinedGCode([part], placed).gcode).toBe(before)
  })
  it('uses a curve midpoint rather than the chord midpoint for curved tabs', () => {
    const curved = createPartFromGCode('arc.nc', 'G21\nG90\nG00 X10 Y0 Z20\n(No. 1 Hole machining: Round)\nG01 Z-12.2 F600\nG01 Z-6.2\nG03 X0 Y10 I-10 J0 F3000\nG01 Z-12.2\nG01 X10 Y0\nG00 Z20\nM30')
    const [tab] = locatePartTabs(curved).tabs
    expect(tab.points.length).toBeGreaterThan(2)
    expect(tab.center.x).toBeCloseTo(Math.SQRT1_2 * 10, 2)
    expect(tab.center.y).toBeCloseTo(Math.SQRT1_2 * 10, 2)
  })
  it('does not mistake pockets, drills, ramps or clearance travel for tabs', () => {
    for (const operation of ['pocket', 'Drill', 'Helical drill']) {
      expect(locatePartTabs(createPartFromGCode('pocket.nc', legacy.replace('Part machining', `${operation} machining`))).tabs).toEqual([])
    }
    const cleared = createPartFromGCode('untabbed.nc', legacy.replaceAll('G00 Z-12.4\n', ''))
    expect(locatePartTabs(cleared).tabs).toEqual([])
    expect(locatePartTabs(cleared).warnings.join()).toContain('No tab locations identified')
  })
  it('does not guess on unclassified imported NC', () => {
    const result = locatePartTabs(createPartFromGCode('unknown.nc', legacy.replace('(No. 1 Part machining: Outer)', '')))
    expect(result.tabs).toEqual([])
    expect(result.warnings.join()).toContain('cannot be identified reliably')
  })
  it('does not reintroduce explicitly removed hole tabs', () => {
    const source = { ...drawing, features: drawing.features.map(feature => ({ ...feature, door: false, layer: 'CUT' })) }
    const cam = generateCam(source, { ...preset, operations: { f1: { tabs: 0 } } })
    expect(cam.errors).toEqual([])
    expect(locatePartTabs(createPartFromGCode('holes.nc', cam.gcode)).tabs).toHaveLength(4)
  })
  it('rejects missing components, empty sheets and invalid dimensions', () => {
    expect(() => buildTabMap([], sheet)).toThrow('missing')
    expect(() => buildTabMap([part], { ...sheet, instances: [] })).toThrow('Place parts')
    expect(() => buildTabMap([part], { ...sheet, width: NaN })).toThrow('dimensions')
  })
})
