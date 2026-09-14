import { describe, expect, it } from 'vitest'
import { createPartFromGCode } from './importPart'
import { exportCombinedGCode } from './exporter'
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
      maxDepthOfCut: 6,
      finalCutDepth: undefined,
      applyXyFeedRate: true,
      cuttingFeedRateMmPerSecond: 75,
      plungeFeedRateMmPerSecond: 500 / 60,
      rampFeedRateMmPerSecond: 10,
    },
    gcodePresets: [],
  }
}

function makeInstance(partId: string): PartInstance {
  return { id: 'i1', partId, sheetIndex: 0, x: 10, y: 10, rotation: 0, locked: false }
}

describe('G-code exporter feed-rate selection', () => {
  it('uses plunge, ramp and cutting feeds without unsafe modal inheritance', () => {
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
    expect(result.gcode).toContain('G01 Z-0.25 F500')
    expect(result.gcode).toContain('G01 X20 Y10 Z-1.5 F600')
    expect(result.gcode).toContain('G01 X30 Y10 Z-3 F600')
    expect(result.gcode).toContain('G01 X40 Y10 F4500')
    expect(result.gcode).toContain('G01 Z-4 F500')
    expect(result.gcode).toContain('G01 X50 Y10 Z-5 F600')
    expect(result.gcode).toContain('G01 X60 Y10 F4500')
  })

  it('uses ramp feed for helical arc moves that enter deeper into material', () => {
    const part = createPartFromGCode('arc.nc', 'G21\nG90\nG01 X0 Y0\nG02 X10 Y0 Z-1 I5 J0 F4500\nM30')
    const result = exportCombinedGCode([part], makeSheet(makeInstance(part.id)))

    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('G02 X20 Y10 Z-1 I5 J0 F600')
  })

  it('positions at the actual first toolpath start before an initial arc move', () => {
    const part = createPartFromGCode('arc-start.nc', 'G21\nG90\nG00 X55 Y23.35\nG02 X51.875 Y21.4014 Z-1 I-2.25 J0 F4500\nM30')
    const result = exportCombinedGCode([part], makeSheet(makeInstance(part.id)))

    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('G00 X13.125 Y11.9486')
    expect(result.gcode).toContain('G02 X10 Y10 Z-1 I-2.25 J0 F600')
  })

  it('emits spindle start before the first cutting or ramping move', () => {
    const part = createPartFromGCode('spindle.nc', 'G21\nG90\nG01 X0 Y0\nG01 Z-1\nM30')
    const result = exportCombinedGCode([part], makeSheet(makeInstance(part.id)))

    const spindleIndex = result.gcode.indexOf('M03')
    const firstCutIndex = result.gcode.indexOf('G01 X10 Y10 F4500')
    expect(spindleIndex).toBeGreaterThan(-1)
    expect(firstCutIndex).toBeGreaterThan(spindleIndex)
  })

  it('uses mm/s settings while emitting G-code feed words in mm/min', () => {
    const part = createPartFromGCode('units.nc', 'G21\nG90\nG01 X0 Y0\nG01 X10 Y0 F1\nM30')
    const result = exportCombinedGCode([part], makeSheet(makeInstance(part.id)))

    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('G01 X20 Y10 F4500')
  })

  it('scales only full-depth operations when final cut depth is configured', () => {
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
    sheet.gcodeSettings.finalCutDepth = 20
    const result = exportCombinedGCode([part], sheet)

    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('G01 Z-1.5 F500')
    expect(result.gcode).toContain('G01 X20 Y10 Z-3 F600')
    expect(result.gcode).toContain('G01 X30 Y10 F4500')
    expect(result.gcode).toContain('G01 Z-10 F500')
    expect(result.gcode).toContain('G01 X50 Y10 Z-20 F600')
  })

  it('does not scale rapid Z clearances when overriding full-depth operations', () => {
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
    sheet.gcodeSettings.finalCutDepth = 20
    const result = exportCombinedGCode([part], sheet)

    expect(result.errors).toEqual([])
    expect(result.gcode).toContain('G01 Z-10 F500')
    expect(result.gcode).toContain('G00 Z-2')
    expect(result.gcode).toContain('G01 X20 Y10 Z-20 F600')
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
})
