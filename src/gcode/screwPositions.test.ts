import { describe, expect, it } from 'vitest'
import type { Sheet } from '../models/Sheet'
import { createPartFromGCode } from './importPart'
import { distanceToBounds, planScrewPositions, screwClearanceMm } from './screwPositions'
import { preparationBounds } from './preparationBounds'
import { exportCombinedGCode, exportPhysicalSheetGCodes } from './exporter'
import { simulateGCode } from './simulator'

const rectangle = () => createPartFromGCode('rectangle.nc', [
  'G21', 'G17', 'G90', 'G94', 'F480',
  '(No. 1 Part machining: Profile)',
  'G00 X0 Y0 Z5', 'G01 Z-3', 'G01 X100 Y0 F1200',
  'G01 X100 Y80', 'G01 X0 Y80', 'G01 X0 Y0',
  'G00 Z5', 'M30',
].join('\n'))

function sheetFor(partId: string): Sheet {
  return {
    name: 'Preparation', width: 1220, height: 1220, spacing: 30, borderSpacing: 20,
    screwMarkingEnabled: true,
    instances: [
      { id: 'first', partId, x: 20, y: 20, rotation: 0, sheetIndex: 0, locked: false },
      { id: 'second', partId, x: 150, y: 20, rotation: 0, sheetIndex: 0, locked: false },
    ],
    gcodeSettings: { startGcode: 'G21\nG17\nG90\nG94', spindleStartGcode: 'S18000\nM03', endGcode: 'M05\nM30', safeZ: 5 },
  }
}

describe('screw-position preparation', () => {
  it('places sparse marks only in waste within the occupied extent, clear of every part', () => {
    const part = rectangle()
    const sheet = sheetFor(part.id)
    const plan = planScrewPositions([part], sheet, 0)
    expect(plan.errors).toEqual([])
    expect(plan.points.length).toBeGreaterThanOrEqual(4)
    expect(plan.points.length).toBeLessThanOrEqual(8)
    for (const point of plan.points) {
      expect(point.x).toBeGreaterThanOrEqual(10)
      expect(point.x).toBeLessThanOrEqual(240)
      expect(point.y).toBeGreaterThanOrEqual(10)
      expect(point.y).toBeLessThanOrEqual(90)
      for (const instance of sheet.instances) {
        expect(distanceToBounds(point, preparationBounds(part, instance).bounds)).toBeGreaterThanOrEqual(screwClearanceMm)
      }
    }
    expect(planScrewPositions([part], sheet, 0)).toEqual(plan)
  })

  it('recomputes positions for rotated parts and keeps physical sheets independent', () => {
    const part = rectangle()
    const sheet = sheetFor(part.id)
    sheet.instances[1] = { ...sheet.instances[1], sheetIndex: 1, x: 200, y: 100, rotation: 90 }
    const first = planScrewPositions([part], sheet, 0)
    const second = planScrewPositions([part], sheet, 1)
    expect(first.errors).toEqual([])
    expect(second.errors).toEqual([])
    expect(first.points.every(point => point.x <= 120 && point.y <= 100)).toBe(true)
    expect(second.points.some(point => point.x > 120)).toBe(true)
    expect(second.points.every(point => distanceToBounds(point, preparationBounds(part, sheet.instances[1]).bounds) >= screwClearanceMm)).toBe(true)
  })

  it('blocks marking when the layout leaves no clearance instead of drilling inside a part', () => {
    const part = rectangle()
    const sheet = sheetFor(part.id)
    sheet.instances = [{ ...sheet.instances[0], x: 0, y: 0 }]
    const plan = planScrewPositions([part], sheet, 0)
    expect(plan.points).toEqual([])
    expect(plan.errors[0]).toContain('No screw marks fit')
    expect(exportCombinedGCode([part], sheet).errors).toContain(plan.errors[0])
  })

  it.each([false, undefined])('does not mark empty sheets or sheets without explicit opt-in (%s)', (enabled) => {
    const part = rectangle()
    const sheet = sheetFor(part.id)
    expect(planScrewPositions([part], sheet, 1).points).toEqual([])
    sheet.screwMarkingEnabled = enabled
    const result = exportCombinedGCode([part], sheet)
    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('Reach check:')
    expect(result.gcode).not.toContain('(Screw mark')
    expect(result.gcode).not.toContain('M00')
  })

  it('checks reach, marks Z-2 with separate retracts, stops and pauses, then restarts the original machining', () => {
    const part = rectangle()
    const sheet = sheetFor(part.id)
    const plan = planScrewPositions([part], sheet, 0)
    const result = exportCombinedGCode([part], sheet)
    expect(result.errors).toEqual([])
    const markStart = result.gcode.indexOf('(Screw marks:')
    const pause = result.gcode.indexOf('\nM00\n')
    const firstPart = result.gcode.indexOf('(Part:')
    expect(result.gcode.indexOf('G00 X250 Y100')).toBeLessThan(markStart)
    expect(result.gcode.indexOf('M03', markStart)).toBeLessThan(result.gcode.indexOf('G01 Z-2'))
    expect(pause).toBeGreaterThan(markStart)
    expect(firstPart).toBeGreaterThan(pause)
    expect(result.gcode.indexOf('M03', pause)).toBeLessThan(firstPart)
    expect(result.gcode).toContain('G00 Z5\nM05\nG00 X0 Y0\n(Fit recessed screws in the marked positions, then press START)\nM00')
    const simulation = simulateGCode(result.gcode.slice(0, pause))
    expect(simulation.errors).toEqual([])
    const drilling = simulation.moves.filter(move => move.type !== 'rapid')
    expect(drilling).toHaveLength(plan.points.length)
    expect(drilling.every(move => move.end.z === -2 && move.start.x === move.end.x && move.start.y === move.end.y && move.feedMmPerMinute === 300)).toBe(true)
    for (const move of simulation.moves) {
      if (move.start.x !== move.end.x || move.start.y !== move.end.y) {
        expect(move.start.z).toBe(5)
        expect(move.end.z).toBe(5)
      }
    }
    const withoutMarking = exportCombinedGCode([part], { ...sheet, screwMarkingEnabled: false })
    expect(result.gcode.slice(firstPart)).toBe(withoutMarking.gcode.slice(withoutMarking.gcode.indexOf('(Part:')))
    const machining = simulateGCode(result.gcode).moves.filter(move => move.raw === 'G01 Z-3')
    expect(machining).toHaveLength(2)
    expect(machining.every(move => move.feedMmPerMinute === 480)).toBe(true)
  })

  it('marks and pauses separately on every physical sheet in either export mode', () => {
    const part = rectangle()
    const sheet = sheetFor(part.id)
    sheet.instances[1].sheetIndex = 1
    const combined = exportCombinedGCode([part], sheet)
    expect(combined.errors).toEqual([])
    expect(combined.gcode.match(/\nM00\n/g)).toHaveLength(3)
    const separate = exportPhysicalSheetGCodes([part], sheet)
    expect(separate).toHaveLength(2)
    for (const result of separate) {
      expect(result.errors).toEqual([])
      expect(result.gcode.match(/\nM00\n/g)).toHaveLength(1)
      expect(result.gcode).toContain('G01 Z-2 F300')
    }
  })

  it('rejects unknown source feeds or missing spindle start rather than inheriting marking settings', () => {
    const part = createPartFromGCode('no-feed.nc', 'G21\nG90\nG01 X0 Y0\nG01 X100 Y80\nM30')
    const sheet = sheetFor(part.id)
    expect(exportCombinedGCode([part], sheet).errors[0]).toContain('must specify a source feed')
    const normalPart = rectangle()
    const noSpindle = sheetFor(normalPart.id)
    noSpindle.gcodeSettings.spindleStartGcode = ''
    expect(exportCombinedGCode([normalPart], noSpindle).errors[0]).toContain('positive S speed and M03')
  })

  it('includes outlying drilling positions in the reach and screw keepout area', () => {
    const part = createPartFromGCode('drill.nc', 'G21\nG90\n(No. 1 Drill machining: Drill)\nG00 X150 Y80 Z5\nG01 Z-3 F300\nG00 Z5\n(No. 2 Profile)\nG00 X0 Y0\nG01 Z-3 F300\nG01 X100 Y0\nG01 X100 Y40\nM30')
    const sheet = sheetFor(part.id)
    sheet.instances = [sheet.instances[0]]
    expect(preparationBounds(part, sheet.instances[0]).bounds.maxX).toBe(170)
    const result = exportCombinedGCode([part], sheet)
    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('G00 X170 Y100')
  })

  it('includes the complete circle in reach and keepout bounds', () => {
    const part = createPartFromGCode('circle.nc', 'G21\nG90\n(No. 1 Circle)\nG00 X10 Y0 Z5\nG01 Z-2 F300\nG03 X10 Y0 I-10 J0 F600\nM30')
    const sheet = sheetFor(part.id)
    sheet.instances = [sheet.instances[0]]
    expect(preparationBounds(part, sheet.instances[0]).bounds).toEqual({ minX: 20, minY: 20, maxX: 40, maxY: 40 })
    expect(exportCombinedGCode([part], sheet).gcode).toContain('G00 X40 Y40')
  })

  it('blocks geometry that cannot be checked and a spindle block ending in M05', () => {
    const part = createPartFromGCode('radius.nc', 'G21\nG90\nG01 X0 Y0 F600\nG02 X10 Y0 R5\nM30')
    expect(exportCombinedGCode([part], sheetFor(part.id)).errors.some(error => error.includes('I/J arc geometry'))).toBe(true)
    const normal = rectangle()
    const sheet = sheetFor(normal.id)
    sheet.gcodeSettings.spindleStartGcode = 'S18000\nM03\nM05'
    expect(exportCombinedGCode([normal], sheet).errors.some(error => error.includes('positive S speed and M03'))).toBe(true)
  })
})
