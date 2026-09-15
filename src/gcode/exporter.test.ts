import { describe, expect, it } from 'vitest'
import { createPartFromGCode } from './importPart'
import { exportCombinedGCode, exportPhysicalSheetGCodes } from './exporter'
import { validateSheet } from './validator'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'

function makeSheet(instance: PartInstance): Sheet {
  return {
    name: 'Feed Test',
    width: 500,
    height: 500,
    spacing: 5,
    borderSpacing: 10,
    instances: [instance],
    gcodeSettings: {
      startGcode: 'G21\nG17\nG90\nG94',
      spindleStartGcode: 'S18000\nM03',
      endGcode: 'M05\nM30',
      safeZ: 5,
      reachCheckEnabled: false,
    },
    gcodePresets: [],
  }
}

function makeInstance(partId: string): PartInstance {
  return { id: 'i1', partId, sheetIndex: 0, x: 10, y: 10, rotation: 0, locked: false }
}

function collectOperationDepths(gcode: string): Map<string, number> {
  const operationDepths = new Map<string, number>()
  let operation = '<none>'

  for (const line of gcode.split('\n')) {
    const operationMatch = line.trim().match(/^\((No\.\s*\d+\s+.+)\)$/i)
    if (operationMatch) operation = operationMatch[1]
    const zMatch = line.match(/\bZ([-+]?\d*\.?\d+)/i)
    const motionMatch = line.match(/\bG0?([123])\b/i)
    if (!zMatch || !motionMatch) continue
    const z = Number(zMatch[1])
    if (z >= 0) continue
    operationDepths.set(operation, Math.min(operationDepths.get(operation) ?? 0, z))
  }

  return operationDepths
}

describe('G-code exporter source machining settings', () => {
  it('preserves source plunge, ramp and cutting feeds', () => {
    const part = createPartFromGCode(
      'feeds.nc',
      [
        'G21',
        'G90',
        'G01 X0 Y0',
        'G01 Z-0.25 F480',
        'G01 X10 Y0 Z-1.5 F4500',
        'G01 X20 Y0 Z-3 F4500',
        'G01 X30 Y0 F4500',
        'G01 Z-4 F4500',
        'G01 X40 Y0 Z-5 F4500',
        'G01 X50 Y0 F4500',
        'M30',
      ].join('\n'),
    )
    const result = exportCombinedGCode([part], makeSheet(makeInstance(part.id)))

    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('G01 Z-0.25 F480')
    expect(result.gcode).toContain('G01 X20 Y10 Z-1.5 F4500')
    expect(result.gcode).toContain('G01 X30 Y10 Z-3 F4500')
    expect(result.gcode).toContain('G01 X40 Y10 F4500')
    expect(result.gcode).toContain('G01 Z-4 F4500')
    expect(result.gcode).toContain('G01 X50 Y10 Z-5 F4500')
    expect(result.gcode).toContain('G01 X60 Y10 F4500')
  })

  it('preserves the source feed for helical arc moves', () => {
    const part = createPartFromGCode('arc.nc', 'G21\nG90\nG01 X0 Y0\nG02 X10 Y0 Z-1 I5 J0 F4500\nM30')
    const result = exportCombinedGCode([part], makeSheet(makeInstance(part.id)))

    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('G02 X20 Y10 Z-1 I5 J0 F4500')
  })

  it('positions at the actual first toolpath start before an initial arc move', () => {
    const part = createPartFromGCode('arc-start.nc', 'G21\nG90\nG00 X55 Y23.35\nG02 X51.875 Y21.4014 Z-1 I-2.25 J0 F4500\nM30')
    const result = exportCombinedGCode([part], makeSheet(makeInstance(part.id)))

    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('G00 X13.125 Y11.9486')
    expect(result.gcode).toContain('G02 X10 Y10 Z-1 I-2.25 J0 F4500')
  })

  it('emits spindle start before the first cutting or ramping move', () => {
    const part = createPartFromGCode('spindle.nc', 'G21\nG90\nG01 X0 Y0\nG01 Z-1\nM30')
    const result = exportCombinedGCode([part], makeSheet(makeInstance(part.id)))

    const spindleIndex = result.gcode.indexOf('M03')
    const firstCutIndex = result.gcode.indexOf('G01 X10 Y10')
    expect(spindleIndex).toBeGreaterThan(-1)
    expect(firstCutIndex).toBeGreaterThan(spindleIndex)
  })

  it('preserves source feed units and modal feed inheritance', () => {
    const part = createPartFromGCode('units.nc', 'G21\nG90\nG01 X0 Y0\nG01 X10 Y0 F1\nG01 X20 Y0\nM30')
    const result = exportCombinedGCode([part], makeSheet(makeInstance(part.id)))

    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('G01 X20 Y10 F1\nG01 X30 Y10\n')
  })

  it('preserves pocket and profile pass depths', () => {
    const part = createPartFromGCode(
      'depth.nc',
      [
        'G21',
        'G90',
        '(No. 1 Pocketing: Pocket)',
        'G01 X0 Y0',
        'G01 Z-1.5',
        'G01 X10 Y0 Z-3',
        'G01 X20 Y0',
        'G00 Z5',
        '(No. 2 Part machining: Profile)',
        'G01 X30 Y0',
        'G01 Z-5',
        'G01 X40 Y0 Z-10',
        'M30',
      ].join('\n'),
    )
    const sheet = makeSheet(makeInstance(part.id))
    const result = exportCombinedGCode([part], sheet)

    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('G01 Z-1.5\n')
    expect(result.gcode).toContain('G01 X20 Y10 Z-3\n')
    expect(result.gcode).toContain('G01 X30 Y10\n')
    expect(result.gcode).toContain('G01 Z-5\n')
    expect(result.gcode).toContain('G01 X50 Y10 Z-10\n')
  })

  it('preserves rapid Z clearances and warns about rapids below the surface', () => {
    const part = createPartFromGCode(
      'rapid-depth.nc',
      [
        'G21',
        'G90',
        '(No. 1 Part machining: Profile)',
        'G01 X0 Y0',
        'G01 Z-5',
        'G00 Z-2',
        'G01 X10 Y0 Z-10',
        'M30',
      ].join('\n'),
    )
    const sheet = makeSheet(makeInstance(part.id))
    const result = exportCombinedGCode([part], sheet)

    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('G01 Z-5\n')
    expect(result.gcode).toContain('G00 Z-2')
    expect(result.gcode).toContain('G01 X20 Y10 Z-10\n')
    expect(result.warnings).toContain('rapid-depth contains 1 rapid Z move below Z0; verify the source CAM clearance path before cutting.')
  })

  it('ignores legacy machining overrides in saved sheets for both export modes and validation', () => {
    const part = createPartFromGCode('legacy.nc', 'G21\nG90\nG01 X0 Y0 F1200\nG01 Z-3 F480\nG01 X10 Y0 Z-6 F600\nG01 X20 Y0 F1800\nM30')
    const sheet = makeSheet(makeInstance(part.id))
    sheet.instances.push({ ...makeInstance(part.id), id: 'i2', sheetIndex: 1 })
    const expectedCombined = exportCombinedGCode([part], sheet)
    const expectedSheets = exportPhysicalSheetGCodes([part], sheet)
    const expectedValidation = validateSheet([part], sheet)

    const legacyOverrides = {
      maxDepthOfCut: 0.1,
      finalCutDepth: 20,
      applyXyFeedRate: true,
      cuttingFeedRateMmPerSecond: 75,
      plungeFeedRateMmPerSecond: 10,
      rampFeedRateMmPerSecond: 10,
      cuttingFeedRateMmPerMinute: 4500,
      plungeFeedRateMmPerMinute: 500,
      rampFeedRateMmPerMinute: 500,
      xyFeedRateMmPerSecond: 50,
      xyFeedRate: 3000,
    }
    sheet.gcodeSettings = { ...sheet.gcodeSettings, ...legacyOverrides }

    expect(exportCombinedGCode([part], sheet)).toEqual(expectedCombined)
    expect(exportPhysicalSheetGCodes([part], sheet)).toEqual(expectedSheets)
    expect(validateSheet([part], sheet)).toEqual(expectedValidation)
  })

  it('emits optional reach check before spindle start', () => {
    const part = createPartFromGCode('reach.nc', 'G21\nG90\nG01 X0 Y0\nG01 X50 Y20\nM30')
    const sheet = makeSheet(makeInstance(part.id))
    sheet.gcodeSettings.reachCheckEnabled = true
    const result = exportCombinedGCode([part], sheet)

    const reachIndex = result.gcode.indexOf('G00 X60 Y30')
    const spindleIndex = result.gcode.indexOf('M03')
    expect(result.errors).toEqual([])
    expect(reachIndex).toBeGreaterThan(-1)
    expect(spindleIndex).toBeGreaterThan(reachIndex)
  })

  it('exports nested Estlcam standalone programs without preserving terminal parking moves', () => {
    const part = createPartFromGCode(
      'side-l.nc',
      [
        'G21',
        'G17',
        'G90',
        'G94',
        'G00 Z5.0000',
        'S18000 M03',
        '(No. 1 Pocketing parallel: Pocket 1)',
        'G00 X36.1740 Y33.6971 F2400',
        'G00 Z0.5000 F900',
        'G01 X37.7615 F420 S1',
        'G02 X35.3802 Y32.3223 Z-0.5000 I-1.5875 J0.0000',
        'G02 Y35.0719 Z-1.5000 I0.7937 J1.3748',
        'G02 X37.7615 Y33.6971 Z-2.5000 I0.7938 J-1.3748',
        'G02 X36.9677 Y32.3223 Z-3.0000 I-1.5875 J0.0000',
        'G00 Z5.0000 F900',
        '(No. 2 Pocketing parallel: Pocket 2)',
        'G00 X301.1740 Y33.6971 Z5.0000 F2400',
        'G00 Z0.5000 F900',
        'G01 X302.7615 F420',
        'G02 X300.3802 Y32.3223 Z-0.5000 I-1.5875 J0.0000',
        'G02 Y35.0719 Z-1.5000 I0.7937 J1.3748',
        'G02 X302.7615 Y33.6971 Z-2.5000 I0.7937 J-1.3748',
        'G02 X301.9677 Y32.3223 Z-3.0000 I-1.5875 J0.0000',
        'G00 Z5.0000 F900',
        '(No. 3 Part machining: Profile)',
        'G00 X279.3980 Y33.6971 Z5.0000 F2400',
        'G00 Z0.5000 F900',
        'G01 Z0.0000 F420',
        'G01 Y25.4546 Z-3.0000',
        'G01 Y25.0961 F2100',
        'G01 Y25.4546 Z-6.0000 F420',
        'G01 Y25.0961 F2100',
        'G01 Y25.4546 Z-9.0000 F420',
        'G01 Y25.0961 F2100',
        'G01 Y25.4546 Z-12.0000 F420',
        'G01 Y25.0961 F2100',
        'G01 Y25.4546 Z-15.0000 F420',
        'G01 Y25.0961 F2100',
        'G01 Y25.4546 Z-18.0000 F420',
        'G01 Y25.0961 F2100',
        'G01 Y33.1476 Z-18.2000 F420',
        'G01 Y25.0961 F2100',
        'G00 Z5.0000 F900',
        'G00 X0.0000 Y0.0000 F2400',
        'G00 Z0.0000 F900',
        'M30',
      ].join('\n'),
    )
    const first = makeInstance(part.id)
    const second: PartInstance = { ...makeInstance(part.id), id: 'i2', x: 320 }
    const sheet = makeSheet(first)
    sheet.instances = [first, second]
    const result = exportCombinedGCode([part], sheet)
    const operationDepths = collectOperationDepths(result.gcode)

    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('(No. 1 Pocketing parallel: Pocket 1)')
    expect(result.gcode).toContain('(No. 2 Pocketing parallel: Pocket 2)')
    expect(operationDepths.get('No. 1 Pocketing parallel: Pocket 1')).toBe(-3)
    expect(operationDepths.get('No. 2 Pocketing parallel: Pocket 2')).toBe(-3)
    expect(operationDepths.get('No. 3 Part machining: Profile')).toBe(-18.2)
    expect(result.gcode).not.toMatch(/\nG00 X(?:10|320) Y10 F2400\nG00 Z0 F900\n/)
  })
})
