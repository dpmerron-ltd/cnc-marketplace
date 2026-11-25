import { describe, expect, it } from 'vitest'
import { buildDailyPlan, dailyPlanIsCurrent, scheduleDay, dayCutBudgetSeconds, type DayCut } from './dailyPlan'
import { newWorkspace, sheetSignature } from './production'
import { testItem, testParts } from '../test/jobFixtures'
import { defaultProgramSettings } from '../gcode/programSettings'
import { buildPartLabels } from '../labels/partLabels'
import type { Sheet } from '../models/Sheet'
import type { ShopifyOrder } from '../orders/types'
const cut = (id: string, hours: number, date: number, material = '12mm'): DayCut => ({
  jobId: id,
  sheetIndex: 0,
  signature: 'x',
  orders: [id],
  material,
  materialKey: material,
  placedAt: date,
  seconds: hours * 3600,
  parts: 1
})
const sheet: Sheet = {
  name: 'Blank',
  width: 500,
  height: 500,
  spacing: 10,
  borderSpacing: 10,
  screwMarkingEnabled: false,
  instances: [],
  gcodeSettings: { ...defaultProgramSettings, safeZ: 20 }
}
const order = (id: string, createdAt: string, quantity = 1): ShopifyOrder => ({
  id: `gid://shopify/Order/${id}`,
  name: `#${id}`,
  createdAt,
  lineItems: {
    nodes: [
      {
        id: `line-${id}`,
        title: 'Locker',
        variantTitle: null,
        sku: testItem.sku,
        quantity,
        currentQuantity: quantity,
        unfulfilledQuantity: quantity
      }
    ],
    pageInfo: { hasNextPage: false, endCursor: null }
  }
})
const parts = testParts.map((p) => ({ ...p, stockMaterial: { thicknessMm: 18, type: 'Plywood', finish: 'Natural' } }))
const input = () => ({
  workspace: newWorkspace(sheet),
  parts,
  items: [testItem],
  baseSheet: sheet,
  orders: [order('2', '2026-11-24T10:00:00Z'), order('1', '2026-11-23T10:00:00Z')],
  shop: 'test.myshopify.com',
  owner: 'owner',
  programs: defaultProgramSettings
})
describe('daily machine scheduling', () => {
  it('selects oldest sheets first and caps two machines at 12 combined cutting hours', () => {
    const plan = scheduleDay([cut('new', 1, 3), cut('old', 6, 1), cut('middle', 6, 2)])
    expect(plan.cuts.map((c) => c.jobId)).toEqual(['old', 'middle'])
    expect(plan.deferred.map((c) => c.jobId)).toEqual(['new'])
    expect(plan.cuts.reduce((n, c) => n + c.seconds, 0)).toBe(dayCutBudgetSeconds)
    for (const c of plan.cuts) expect(c.endMinute).toBeLessThanOrEqual(17 * 60)
    expect(new Set(plan.cuts.map((c) => c.machine)).size).toBe(2)
  })
  it('reserves handling and defers a sheet that cannot finish within one machine day', () => {
    const result = scheduleDay([cut('too-long', 8, 0), cut('fits', 7.75, 1)])
    expect(result.cuts).toHaveLength(1)
    expect(result.cuts[0].endMinute).toBe(1020)
    expect(result.deferred[0].jobId).toBe('too-long')
  })
  it('uses matching material for a newer top-up without replacing selected older work', () => {
    const result = scheduleDay([cut('old12', 3, 1), cut('old18', 3, 2, '18mm'), cut('topup12', 0.5, 3)])
    expect(result.cuts.find((c) => c.jobId === 'topup12')?.machine).toBe(
      result.cuts.find((c) => c.jobId === 'old12')?.machine
    )
    expect(result.cuts).toHaveLength(3)
  })
  it('never overlaps sheets and uses the second machine when handling exhausts the first', () => {
    const result = scheduleDay(Array.from({ length: 40 }, (_, i) => cut(String(i), 0.1, i)))
    for (const m of [1, 2]) {
      let end = 540
      for (const c of result.cuts.filter((c) => c.machine === m)) {
        expect(c.startMinute).toBeGreaterThanOrEqual(end + 15)
        expect(c.endMinute).toBeLessThanOrEqual(1020)
        end = c.endMinute
      }
    }
  })
  it('rejects unknown or nonfinite runtime instead of treating it as free', () => {
    expect(() => scheduleDay([cut('bad', NaN, 1)])).toThrow('runtime')
  })
})
describe('open orders into the daily plan', () => {
  it('nests matching orders together and retains each order number on labels and after replanning', () => {
    const first = buildDailyPlan(input())
    expect(first.dailyPlan?.issues).toEqual([])
    expect(first.dailyPlan?.cuts).toHaveLength(1)
    const job = first.jobs.find((j) => j.sheet.instances.length)!
    expect(job.sheet.instances).toHaveLength(4)
    const labels = buildPartLabels(parts, [testItem], job.sheet)
    expect(labels.map((l) => l.order).sort()).toEqual(['#1', '#1', '#2', '#2'])
    expect(dailyPlanIsCurrent(first)).toBe(true)
    expect(dailyPlanIsCurrent(first, { ...defaultProgramSettings, spindleStartGcode: 'S16000 M03' })).toBe(false)
    const second = buildDailyPlan({ ...input(), workspace: first })
    expect(second.jobs).toHaveLength(first.jobs.length)
    expect(second.jobs.flatMap((j) => j.sheet.instances)).toHaveLength(4)
    const changed = {
      ...first,
      jobs: first.jobs.map((j) => (j.id === job.id ? { ...j, sheet: { ...j.sheet, width: 501 } } : j))
    }
    expect(dailyPlanIsCurrent(changed)).toBe(false)
  })
  it('tops up existing compatible waiting sheets and keeps order identities after merging', () => {
    const initial = input()
    const first = buildDailyPlan({ ...initial, orders: [initial.orders[1]] })
    const existing = first.jobs.find((j) => j.sheet.instances.length)!
    const second = buildDailyPlan({ ...initial, workspace: first })
    const activeSheets = second.jobs.filter((j) => !j.archived && j.sheet.instances.length)
    expect(activeSheets).toHaveLength(1)
    expect(activeSheets[0].id).toBe(existing.id)
    expect(activeSheets[0].sheet.instances).toHaveLength(4)
    expect(new Set(buildPartLabels(parts, [testItem], activeSheets[0].sheet).map((l) => l.order))).toEqual(
      new Set(['#1', '#2'])
    )
    expect(second.dailyPlan?.cuts).toHaveLength(1)
    expect(first.jobs.find((j) => j.id === existing.id)?.sheet.instances).toHaveLength(2)
  })
  it('imports only unfulfilled quantity and excludes cancelled or closed orders', () => {
    const i = input()
    i.orders[0].lineItems.nodes[0] = {
      ...i.orders[0].lineItems.nodes[0],
      quantity: 3,
      currentQuantity: 3,
      unfulfilledQuantity: 1
    }
    i.orders[1].cancelledAt = '2026-11-24T00:00:00Z'
    const result = buildDailyPlan(i)
    expect(result.jobs.flatMap((j) => j.sheet.instances)).toHaveLength(2)
    expect(result.dailyPlan?.orders.map((o) => o.name)).toEqual(['#2'])
  })
  it('reports missing dates, SKU matches and material instead of inventing capacity', () => {
    const i = input()
    i.orders[0].createdAt = undefined
    i.orders[1].lineItems.nodes[0].sku = 'missing'
    const result = buildDailyPlan(i)
    expect(result.dailyPlan?.cuts).toHaveLength(0)
    expect(result.dailyPlan?.issues).toHaveLength(2)
    const noMaterial = buildDailyPlan({ ...input(), parts: testParts })
    expect(noMaterial.dailyPlan?.cuts).toHaveLength(0)
    expect(noMaterial.dailyPlan?.issues.join()).toContain('material')
  })
  it('does not recut completed sheets or overwrite a machine currently cutting', () => {
    const first = buildDailyPlan(input()),
      job = first.jobs.find((j) => j.sheet.instances.length)!
    job.sheets[0] = { stage: 'cut', signature: sheetSignature(job.sheet, 0) }
    const next = buildDailyPlan({ ...input(), workspace: first })
    expect(next.dailyPlan?.cuts).toHaveLength(0)
    expect(next.jobs).toHaveLength(first.jobs.length)
    job.sheets[0].stage = 'cutting'
    expect(() => buildDailyPlan({ ...input(), workspace: first })).toThrow('currently cutting')
  })
})
