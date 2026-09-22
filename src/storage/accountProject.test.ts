import { beforeEach, describe, expect, it } from 'vitest'
import { createPartFromGCode } from '../gcode/importPart'
import type { Project } from '../models/Project'
import { copyProjectToAccount, privateProject } from './accountProject'
import { loadProject, saveProject } from './projectStorage'

function fixture(): Project {
  const items = ['alice', 'bob'].map((ownerId) => ({
    id: `${ownerId}-item`, ownerId, name: ownerId, sku: ownerId,
    description: '', createdAt: '', updatedAt: '',
  }))
  const parts = items.map((item) => ({
    ...createPartFromGCode('part.nc', 'G21 G90\nG00 X0 Y0 Z5\nG01 Z-2 F100\nG01 X20 Y20\nG00 Z5', undefined, item.id),
    id: `${item.ownerId}-part`, ownerId: item.ownerId,
  }))
  return {
    version: 1, items, parts, savedAt: '',
    sheet: {
      name: 'Sheet', width: 500, height: 500, spacing: 10, borderSpacing: 10,
      instances: parts.map((part) => ({ id: part.id, partId: part.id, x: 0, y: 0, rotation: 0, locked: false, sheetIndex: 0 })),
      gcodeSettings: { startGcode: '', spindleStartGcode: '', endGcode: '', safeZ: 5 },
    },
  }
}

describe('account-local projects', () => {
  beforeEach(() => localStorage.clear())

  it('keeps browser backups separate and ignores the old shared cache', () => {
    const project = fixture()
    localStorage.setItem('sheet-builder-project', JSON.stringify(project))
    expect(loadProject('alice')).toBeUndefined()
    expect(loadProject(undefined)).toBeUndefined()
    expect(saveProject(project, undefined)).toBe(false)
    expect(saveProject(project, 'alice')).toBe(true)
    expect(loadProject('bob')).toBeUndefined()
    expect(loadProject('alice')?.items?.map((item) => item.ownerId)).toEqual(['alice'])
    saveProject(project, 'bob')
    expect(loadProject('bob')?.parts.map((part) => part.ownerId)).toEqual(['bob'])
    expect(loadProject('alice')?.items?.[0].ownerId).toBe('alice')
  })

  it('preserves the previous backup when the library exceeds browser storage capacity', () => {
    const project = fixture()
    expect(saveProject(project, 'alice')).toBe(true)
    const previous = loadProject('alice')
    project.parts[0].gcode = 'G01 X0 Y0\n'.repeat(220_000)
    expect(saveProject(project, 'alice')).toBe(false)
    expect(loadProject('alice')).toEqual(previous)
  })

  it('removes foreign components, foreign parents, and placements from current and saved sheets', () => {
    const project = fixture()
    project.parts.push({ ...project.parts[0], id: 'wrong-parent', itemId: 'bob-item' })
    project.sheetHistory = [{ id: 'history', name: '', savedAt: '', sheet: project.sheet, selectedItemId: 'bob-item', itemCount: 2, componentCount: 2, placedCount: 2 }]
    const own = privateProject(project, 'alice')
    expect(own.parts.map((part) => part.id)).toEqual(['alice-part'])
    expect(own.sheet.instances.map((instance) => instance.partId)).toEqual(['alice-part'])
    expect(own.sheetHistory?.[0].sheet.instances).toEqual(own.sheet.instances)
    expect(own.sheetHistory?.[0].selectedItemId).toBeUndefined()
  })

  it('imports independent account-owned copies with remapped references', () => {
    const original = fixture()
    original.sheet.orderImports = [{ key: 'shop/order7', name: '#1007', instanceIds: [original.sheet.instances[0].id] }]
    original.items![0].packing = { paddingMm: 10, components: { 'alice-part': { thicknessMm: 12 }, deleted: { thicknessMm: 18 } } }
    const imported = copyProjectToAccount(original, 'charlie')
    expect(imported.items?.every((item) => item.ownerId === 'charlie')).toBe(true)
    expect(imported.parts.every((part) => part.ownerId === 'charlie')).toBe(true)
    expect(imported.items?.[0].id).not.toBe(original.items?.[0].id)
    expect(imported.parts[0].id).not.toBe(original.parts[0].id)
    expect(imported.parts[0].itemId).toBe(imported.items?.[0].id)
    expect(imported.items?.[0].packing).toEqual({ paddingMm: 10, components: { [imported.parts[0].id]: { thicknessMm: 12 } } })
    expect(imported.sheet.instances[0].partId).toBe(imported.parts[0].id)
    expect(imported.sheet.orderImports?.[0].instanceIds).toEqual([imported.sheet.instances[0].id])
    expect(privateProject(imported, 'charlie').parts).toHaveLength(2)
  })
})
