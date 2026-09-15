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
  return { id, partId, sheetIndex: 0, x: 0, y: 0, rotation: 0, locked: false }
}

function makeSheet(instances: PartInstance[]): Sheet {
  return {
    name: 'Test Sheet',
    width: 250,
    height: 250,
    spacing: 5,
    borderSpacing: 10,
    instances,
    gcodeSettings: {
      startGcode: '',
      spindleStartGcode: '',
      endGcode: '',
      safeZ: 5,
      reachCheckEnabled: false,
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
      { x: 10, y: 10 },
      { x: 115, y: 10 },
      { x: 10, y: 65 },
    ])
  })

  it('spills unlocked parts onto additional physical sheets when needed', () => {
    const parts = [makePart('part-a')]
    const instances = Array.from({ length: 11 }, (_, index) => makeInstance(`i${index + 1}`, 'part-a'))

    const nested = autoNest(parts, makeSheet(instances))

    expect(nested.slice(0, 8).every((instance) => instance.sheetIndex === 0)).toBe(true)
    expect(nested.slice(8).every((instance) => instance.sheetIndex === 1)).toBe(true)
    expect(nested[8]).toMatchObject({ sheetIndex: 1, x: 10, y: 10 })
  })
})
