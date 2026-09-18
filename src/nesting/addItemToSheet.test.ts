import { describe, expect, it } from 'vitest'
import { addItemToSheet } from './addItemToSheet'
import { testItem, testParts } from '../test/jobFixtures'
import type { Sheet } from '../models/Sheet'
import { instanceBounds } from '../gcode/transform'
import { rectsOverlap } from '../models/geometry'

const item = { ...testItem, ownerId: 'alice' }
const parts = testParts.map(part => ({ ...part, itemId: item.id, ownerId: 'alice' }))
const sheet: Sheet = { name: 'Test', width: 500, height: 500, borderSpacing: 10, spacing: 30, instances: [], gcodeSettings: { startGcode: '', spindleStartGcode: '', endGcode: '', safeZ: 20 } }

describe('add all item components', () => {
  it('adds every owned component once, keeps existing placements, and supports another complete copy', () => {
    const mixedParts = [...parts, { ...parts[0], id: 'foreign', ownerId: 'bob' }, { ...parts[0], id: 'other-item', itemId: 'other' }]
    const once = addItemToSheet(item, mixedParts, sheet, 'alice', 1)
    expect(once.instances.map(i => i.partId)).toEqual(parts.map(p => p.id))
    expect(once.instances.every(i => i.sheetIndex >= 1)).toBe(true)
    const twice = addItemToSheet(item, mixedParts, once, 'alice', 1)
    expect(twice.instances.slice(0, parts.length)).toEqual(once.instances)
    expect(new Set(twice.instances.map(i => i.id)).size).toBe(parts.length * 2)
    expect(new Set(twice.instances.map(i => i.partNumber)).size).toBe(parts.length * 2)
    for (const [index, instance] of twice.instances.entries()) {
      const bounds = instanceBounds(parts.find(p => p.id === instance.partId)!, instance)
      expect(bounds.minX).toBeGreaterThanOrEqual(10)
      expect(bounds.maxX).toBeLessThanOrEqual(490)
      expect(bounds.maxY).toBeLessThanOrEqual(490)
      for (const other of twice.instances.slice(index + 1).filter(i => i.sheetIndex === instance.sheetIndex)) {
        expect(rectsOverlap(bounds, instanceBounds(parts.find(p => p.id === other.partId)!, other), 30)).toBe(false)
      }
    }
    expect(sheet.instances).toEqual([])
  })
  it('uses further sheets when needed without moving or unlocking existing parts', () => {
    const smallSheet = { ...sheet, width: 140, height: 140 }
    const largeParts = parts.map(p => ({ ...p, width: 100, height: 100, originalBounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 } }))
    const once = addItemToSheet(item, largeParts, smallSheet, 'alice', 0)
    expect(new Set(once.instances.map(i => i.sheetIndex)).size).toBe(largeParts.length)
    expect(once.instances.every(i => !i.locked)).toBe(true)
  })
  it('rejects foreign, empty and oversized items without partially adding components', () => {
    expect(() => addItemToSheet(item, parts, sheet, 'bob', 0)).toThrow('not in your account')
    expect(() => addItemToSheet(item, [], sheet, 'alice', 0)).toThrow('no components')
    expect(() => addItemToSheet(item, [...parts, { ...parts[0], width: 1000, height: 1000 }], sheet, 'alice', 0)).toThrow('does not fit')
    expect(sheet.instances).toEqual([])
  })
})
