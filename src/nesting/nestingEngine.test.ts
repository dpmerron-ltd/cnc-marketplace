import { describe, expect, it, vi } from 'vitest'
import ClipperLib from 'clipper-lib'
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

  it('returns without endless sheet allocation when the footprint disagrees with reported dimensions', () => {
    const part = makePart('part-a')
    part.originalBounds = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 }
    const instances = [makeInstance('i1', part.id)]
    expect(autoNest([part], makeSheet(instances))).toEqual(instances)
  })

  it('does not repeat geometry searches on unchanged sheets that already rejected a component', () => {
    const part = makePart('large')
    const execute = vi.spyOn(ClipperLib.Clipper.prototype, 'Execute')
    const run = (count: number) => {
      execute.mockClear()
      const sheet = { ...makeSheet(Array.from({ length: count }, (_, i) => makeInstance(`i${i}`, part.id))), width: 120, height: 70 }
      const result = autoNest([part], sheet)
      expect(result.map(instance => instance.sheetIndex)).toEqual(Array.from({ length: count }, (_, i) => i))
      expect(result.every(instance => instance.x === 10 && instance.y === 10 && instance.rotation === 0)).toBe(true)
      return execute.mock.calls.length
    }
    try {
      const smaller = run(20)
      expect(smaller).toBeGreaterThan(0)
      expect(run(40)).toBeLessThan(smaller * 2.2)
    } finally { execute.mockRestore() }
  })

  it('matches fresh searches when other components change earlier sheets', () => {
    const large = makePart('large')
    const small = { ...createPartFromGCode('small.nc', 'G21\nG90\nG01 X0 Y0\nG01 X30 Y20\nM30'), id: 'small' }
    const parts = [large, small]
    const instances = [large, large, small, large, small, large].map((part, i) => makeInstance(`i${i}`, part.id))
    const sheet = { ...makeSheet(instances), width: 140, height: 100 }
    let expected: PartInstance[] = []
    for (const instance of instances) {
      expected = autoNest(parts, { ...sheet, instances: [...expected.map(placed => ({ ...placed, locked: true })), instance] })
    }
    expect(autoNest(parts, sheet)).toEqual(expected.map(instance => ({ ...instance, locked: false })))
  })
})
