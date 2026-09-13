import { describe, expect, it } from 'vitest'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'
import { createPartFromGCode } from '../gcode/importPart'
import { autoNest } from './nestingEngine'

function makePart(id: string) {
  return {
    ...createPartFromGCode(`${id}.nc`, 'G21\nG90\nG01 X0 Y0\nG01 X100 Y50\nM30'),
    id,
  }
}

function makeInstance(id: string, partId: string): PartInstance {
  return { id, partId, x: 0, y: 0, rotation: 0, locked: false }
}

function makeSheet(instances: PartInstance[]): Sheet {
  return {
    name: 'Test Sheet',
    width: 250,
    height: 250,
    spacing: 5,
    instances,
    gcodeSettings: {
      startGcode: '',
      endGcode: '',
      safeZ: 5,
      maxDepthOfCut: 6,
      xyFeedRateMmPerSecond: 50,
      applyXyFeedRate: false,
    },
    gcodePresets: [],
  }
}

describe('autoNest', () => {
  it('packs unlocked parts from the bottom-left origin upward', () => {
    const parts = [makePart('part-a')]
    const instances = [makeInstance('i1', 'part-a'), makeInstance('i2', 'part-a'), makeInstance('i3', 'part-a')]

    const nested = autoNest(parts, makeSheet(instances))

    expect(nested.map((instance) => ({ x: instance.x, y: instance.y }))).toEqual([
      { x: 5, y: 5 },
      { x: 110, y: 5 },
      { x: 5, y: 60 },
    ])
  })
})
