import { describe, expect, it } from 'vitest'
import type { Sheet } from '../models/Sheet'
import { createPartFromGCode } from './importPart'
import { exportCombinedGCode, exportPhysicalSheetGCodes } from './exporter'
import { simulateGCode } from './simulator'
import { generateCam } from '../cam/generate'

function fixture() {
  const part = createPartFromGCode('clearances.nc', [
    'G21', 'G90', 'G00 Z5',
    '(No. 1 Drill machining: Hole)',
    'G00 X0 Y0 Z5', 'G00 Z0.5', 'G01 Z-10 F600', 'G00 Z5',
    'X50 Y0', 'G00 Z0.5', 'G01 Z-10 F600',
    '(No. 2 Part machining: Outline)',
    'G00 X0 Y20 Z5', 'G00 Z0.5', 'G01 Z-18.2 F600', 'G01 X50 Y20 F3600',
    'G00 Z-12.2', 'G01 X60 Y20 F3600', 'G01 Z-18.2 F600', 'G01 X60 Y0 F3600',
    'G00 Z5', 'M30',
  ].join('\n'))
  const sheet: Sheet = {
    name: 'Clearances', width: 500, height: 500, spacing: 10, borderSpacing: 20,
    instances: [{ id: 'first', partId: part.id, x: 20, y: 20, rotation: 0, sheetIndex: 0, locked: false }],
    screwMarkingEnabled: false,
    gcodeSettings: { startGcode: 'G21\nG17\nG90\nG94', spindleStartGcode: 'S18000\nM03', endGcode: 'M05\nM30', safeZ: 5 },
  }
  return { part, sheet }
}

describe('safe Z override', () => {
  it.each([12, 18] as const)('preserves generated short pecks through rotated sheet exports for %s mm stock', thickness => {
    const generated = generateCam({ units: 'mm', errors: [], warnings: [], features: [{ x: 30, y: 30 }, { x: 80, y: 70 }].map((point, i) => ({ id: `hole${i}`, name: `Hole ${i}`, layer: 'DRILL', points: [point], closed: false, kind: 'drill' })) }, { thickness, units: 'mm', operations: {} })
    expect(generated.errors).toEqual([])
    const part = createPartFromGCode('pecks.nc', generated.gcode)
    const { sheet } = fixture()
    sheet.safeZOverrideMm = 20
    sheet.instances[0] = { ...sheet.instances[0], partId: part.id, rotation: 90 }
    for (const exported of [exportCombinedGCode([part], sheet), ...exportPhysicalSheetGCodes([part], sheet)]) {
      expect(exported.errors).toEqual([])
      const simulation = simulateGCode(exported.gcode)
      const depths = thickness === 18 ? [2, 4, 6, 8, 9.2] : [2, 4, 4.5]
      const cuts = simulation.moves.filter(move => move.type !== 'rapid' && move.end.z < 0)
      expect(cuts.map(move => -move.end.z)).toEqual([...depths, ...depths])
      const retracts = simulation.moves.filter(move => move.type === 'rapid' && move.start.z < 0)
      expect(retracts.map(move => move.end.z)).toEqual([...depths, ...depths].map(depth => depth === depths.at(-1) ? 20 : 0.5))
      const travel = simulation.moves.filter(move => move.type === 'rapid' && Math.hypot(move.end.x - move.start.x, move.end.y - move.start.y) > 0.001)
      expect(travel.every(move => move.start.z === 20 && move.end.z === 20)).toBe(true)
    }
  })

  it.each(['G00 X50 Y20', 'M00\nG01 Z-4 F600', 'G01 X50 Y20 Z-4 F600'])('does not preserve a short retract before non-peck motion: %s', next => {
    const part = createPartFromGCode('not-peck.nc', `G21\nG90\nG00 Z20\n(No. 1 Drill machining: Hole)\nG00 X0 Y0\nG01 Z-2 F600\nG00 Z0.5\n${next}\nG01 Z-6 F600\nG00 Z20\nG00 X50 Y50\nM30`)
    const { sheet } = fixture()
    sheet.instances[0].partId = part.id
    sheet.safeZOverrideMm = 20
    const exported = exportCombinedGCode([part], sheet)
    expect(exported.errors).toEqual([])
    expect(exported.gcode).toContain('G01 Z-2 F600\nG00 Z20')
  })

  it.each([2, 20])('uses %s mm for preparation, source retracts, lateral rapids, and finishing without changing cuts', (safeZ) => {
    const { part, sheet } = fixture()
    const original = exportCombinedGCode([part], sheet)
    const result = exportCombinedGCode([part], { ...sheet, safeZOverrideMm: safeZ })
    expect(result.errors).toEqual([])
    expect(result.gcode).not.toContain('Z5')
    expect(result.gcode).toContain('G00 Z0.5')
    expect(result.gcode).toContain('G00 Z-12.2')
    expect(result.gcode).toContain(`G00 Z${safeZ}\nM05\nM30`)
    const simulation = simulateGCode(result.gcode)
    const lateralRapids = simulation.moves.filter(move => move.type === 'rapid' && (move.start.x !== move.end.x || move.start.y !== move.end.y))
    expect(lateralRapids.length).toBeGreaterThan(2)
    expect(lateralRapids.every(move => move.start.z === safeZ && move.end.z === safeZ)).toBe(true)
    const cutting = (gcode: string) => simulateGCode(gcode).moves.filter(move => move.type !== 'rapid').map(({ start, end, center, type, feedMmPerMinute }) => ({ start, end, center, type, feedMmPerMinute }))
    expect(cutting(result.gcode)).toEqual(cutting(original.gcode))
  })

  it.each([undefined, null])('leaves source clearance unchanged when disabled (%s)', (disabled) => {
    const { part, sheet } = fixture()
    expect(exportCombinedGCode([part], sheet).gcode).toContain('G00 Z5')
    const overridden = { ...sheet, safeZOverrideMm: 20 }
    expect(exportCombinedGCode([part], { ...overridden, safeZOverrideMm: disabled })).toEqual(exportCombinedGCode([part], sheet))
  })

  it('preserves a first vertical approach above Z0 even when the source start Z is unknown', () => {
    const { sheet } = fixture()
    const part = createPartFromGCode('approach.nc', 'G21\nG90\n(No. 1 Part machining: Profile)\nG00 Z1\nG01 Z-3 F600\nG01 X20 Y0 F1200\nG00 Z5\nM30')
    sheet.instances[0].partId = part.id
    sheet.safeZOverrideMm = 20
    const result = exportCombinedGCode([part], sheet)
    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('G00 Z1\nG01 Z-3 F600')
  })

  it('blocks an ambiguous combined rapid into the material', () => {
    const { sheet } = fixture()
    const part = createPartFromGCode('unsafe.nc', 'G21\nG90\nG00 Z5\n(No. 1 Part machining: Profile)\nG00 X20 Y0 Z-1\nG01 X30 Y0 Z-3 F600\nG00 Z5\nM30')
    sheet.instances[0].partId = part.id
    sheet.safeZOverrideMm = 20
    expect(exportCombinedGCode([part], sheet).errors.join(' ')).toContain('combined rapid XY move into the material')
  })

  it('uses the override for screw marks and each physical sheet in both export modes', () => {
    const { part, sheet } = fixture()
    sheet.safeZOverrideMm = 20
    sheet.screwMarkingEnabled = true
    sheet.instances.push({ ...sheet.instances[0], id: 'second', sheetIndex: 1 })
    const results = [exportCombinedGCode([part], sheet), ...exportPhysicalSheetGCodes([part], sheet)]
    for (const result of results) {
      expect(result.errors).toEqual([])
      expect(result.gcode).toContain('G01 Z-2 F300\nG00 Z20')
      expect(result.gcode).toContain('G00 Z20\nM05\nG00 X0 Y0')
      expect(result.gcode).not.toContain('Z5')
    }
  })

  it.each([0, -1, NaN, Infinity])('blocks invalid override %s without emitting a runnable program', (safeZOverrideMm) => {
    const { part, sheet } = fixture()
    sheet.safeZOverrideMm = safeZOverrideMm
    for (const result of [exportCombinedGCode([part], sheet), ...exportPhysicalSheetGCodes([part], sheet)]) {
      expect(result.errors[0]).toContain('Safe Z')
      expect(result.gcode).toBe('')
    }
  })
})
