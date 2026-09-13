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
      maxDepthOfCut: 6,
      applyXyFeedRate: true,
      cuttingFeedRateMmPerMinute: 4500,
      plungeFeedRateMmPerMinute: 500,
      rampFeedRateMmPerMinute: 600,
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

  it('emits spindle start before the first cutting or ramping move', () => {
    const part = createPartFromGCode('spindle.nc', 'G21\nG90\nG01 X0 Y0\nG01 Z-1\nM30')
    const result = exportCombinedGCode([part], makeSheet(makeInstance(part.id)))

    const spindleIndex = result.gcode.indexOf('M03')
    const firstCutIndex = result.gcode.indexOf('G01 X10 Y10 F4500')
    expect(spindleIndex).toBeGreaterThan(-1)
    expect(firstCutIndex).toBeGreaterThan(spindleIndex)
  })
})
