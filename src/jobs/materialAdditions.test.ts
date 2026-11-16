import { describe, expect, it } from 'vitest'
import { separateMaterialAdditions } from './materialAdditions'
import { testParts } from '../test/jobFixtures'
import type { Sheet } from '../models/Sheet'

const ply = { thicknessMm: 12, type: 'Plywood', finish: 'Plain' }
const mdf = { thicknessMm: 18, type: 'MDF', finish: 'Plain' }
const sheet: Sheet = { name: 'Existing', width: 500, height: 500, spacing: 10, borderSpacing: 10, stockMaterial: ply, instances: [], gcodeSettings: { startGcode: '', endGcode: '', spindleStartGcode: '', safeZ: 20 } }
const addition = (partId: string) => ({ id: crypto.randomUUID(), partId, sheetIndex: 3, x: 10, y: 10, rotation: 0 as const, locked: false })

describe('new jobs for different materials', () => {
  it('separates stock types while keeping matching additions in the current job', () => {
    const parts = testParts.map((p, i) => ({ ...p, stockMaterial: i ? mdf : ply }))
    const result = separateMaterialAdditions(parts, sheet, parts.map(p => addition(p.id)), 0)!
    expect(result.current!.instances.map(i => i.partId)).toEqual([parts[0].id])
    expect(result.newSheets).toHaveLength(1)
    expect(result.newSheets[0].stockMaterial).toEqual(mdf)
    expect(result.newSheets[0].instances[0]).toMatchObject({ partId: parts[1].id, sheetIndex: 0 })
    expect(sheet.instances).toEqual([])
  })
  it('uses the exact exported setup for re-cuts and clears inherited job state', () => {
    const source = { material: 'MDF' }
    const result = separateMaterialAdditions(testParts, { ...sheet, materialProfile: '12', orderNumber: 'OLD', pendingParts: [addition(testParts[0].id)], sheetMaterials: { 3: { stockMaterial: ply } } }, [{ ...addition(testParts[0].id), materialSetup: source, recutId: 'recut' }], 0)!
    expect(result.current).toBeUndefined()
    expect(result.newSheets[0]).toMatchObject({ material: 'MDF', pendingParts: [], instances: [expect.objectContaining({ recutId: 'recut', sheetIndex: 0, materialSetup: source })] })
    expect(result.newSheets[0].stockMaterial).toBeUndefined()
    expect(result.newSheets[0].materialProfile).toBeUndefined()
    expect(result.newSheets[0].sheetMaterials).toBeUndefined()
    expect(result.newSheets[0].orderNumber).toBeUndefined()
  })
  it('leaves matching stock in the existing flow', () => {
    expect(separateMaterialAdditions(testParts.map(p => ({ ...p, stockMaterial: ply })), sheet, [addition(testParts[0].id)], 0)).toBeUndefined()
  })
})
