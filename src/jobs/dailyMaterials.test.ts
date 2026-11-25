import { describe, expect, it } from 'vitest'
import { dailyMaterialRequirements } from './dailyMaterials'
import type { ScheduledCut } from './dailyPlan'
const cut = (
  jobId: string,
  sheetIndex = 0,
  material = '12 mm Plywood · Black Hex',
  materialKey = 'hex12'
): ScheduledCut => ({
  jobId,
  sheetIndex,
  sheetWidthMm: 1220,
  sheetHeightMm: 1220,
  signature: '',
  orders: ['#1', '#2'],
  material,
  materialKey,
  placedAt: 1,
  seconds: 60,
  parts: 10,
  machine: 1,
  startMinute: 555,
  endMinute: 556
})
describe('day plan material squares', () => {
  it('counts physical sheets once across machines and mixed orders, keeping material/thickness/finish separate', () => {
    const shared = cut('a')
    const plan = {
      cuts: [
        shared,
        { ...cut('a', 1), machine: 2 },
        shared,
        cut('b', 0, '18 mm Plywood · Black Hex', 'hex18'),
        cut('c', 0, '12 mm Plywood · Natural', 'natural12')
      ],
      deferred: [cut('later')]
    }
    const result = dailyMaterialRequirements(plan)
    expect(result.totalSquares).toBe(4)
    expect(result.materials.find((m) => m.key === 'hex12')?.squares).toBe(2)
    expect(result.materials).toHaveLength(3)
    expect(result.reviewSheets).toBe(0)
  })
  it('reserves a whole square for a partial sheet without treating it as a fraction', () => {
    expect(
      dailyMaterialRequirements({ cuts: [{ ...cut('a'), sheetWidthMm: 300, sheetHeightMm: 400 }] }).totalSquares
    ).toBe(1)
  })
  it('reads dimensions from existing saved-plan signatures', () => {
    const saved = {
      ...cut('a'),
      sheetWidthMm: undefined,
      sheetHeightMm: undefined,
      signature: JSON.stringify({ settings: { width: 1220, height: 1220 } })
    }
    expect(dailyMaterialRequirements({ cuts: [saved] })).toMatchObject({ totalSquares: 1, reviewSheets: 0 })
  })
  it('does not mislabel oversized or unknown layouts as standard squares', () => {
    const result = dailyMaterialRequirements({
      cuts: [
        { ...cut('a'), sheetWidthMm: 2440 },
        { ...cut('b'), sheetWidthMm: undefined, sheetHeightMm: undefined },
        { ...cut('c'), sheetWidthMm: NaN }
      ]
    })
    expect(result.totalSquares).toBe(0)
    expect(result.reviewSheets).toBe(3)
    expect(dailyMaterialRequirements({ cuts: [] }).totalSquares).toBe(0)
  })
})
