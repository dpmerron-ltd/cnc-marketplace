import { describe, expect, it } from 'vitest'
import { newProductionJob, replanWorkspace } from '../jobs/production'
import { addition, materialPart, materialSheet } from '../test/materialFixtures'
import { orderCuttingSheets } from './cuttingSheets'

const order = { key: 'test.myshopify.com/gid://shopify/Order/123', name: '#1001' }
const part = (id: string, sheetIndex = 0) => ({ ...addition('panel'), id, orderKey: order.key, orderName: order.name, sheetIndex })

describe('sheets for an order', () => {
  it('lists physical sheets once across jobs, keeps mixed-sheet counts and separates pending parts', () => {
    const first = { ...newProductionJob(materialSheet()), id: 'first', name: '2026-11-09-001' }
    first.sheet.instances = [part('a', 2), part('b', 2), { ...part('other', 2), orderKey: 'other', orderName: '#1002' }, part('cut', 0)]
    first.sheets[0] = { stage: 'cut' }
    first.sheet.pendingParts = [part('pending')]
    const second = { ...newProductionJob(materialSheet()), id: 'second' }
    second.sheet.instances = [part('cutting', 1)]
    second.sheets[1] = { stage: 'cutting' }
    const result = orderCuttingSheets([first, second], order)
    expect(result.sheets.map(({ job, index, stage, partCount, totalParts }) => [job.id, index, stage, partCount, totalParts])).toEqual([
      ['first', 2, 'waiting', 2, 3], ['second', 1, 'cutting', 1, 1], ['first', 0, 'cut', 1, 1],
    ])
    expect(result.pending).toEqual([{ job: first, count: 1 }])
  })

  it('uses saved import membership and exact order names for legacy parts without confusing stores or similar numbers', () => {
    const job = newProductionJob(materialSheet())
    job.sheet.instances = [
      { ...part('imported'), orderKey: undefined, orderName: undefined },
      { ...part('legacy'), orderKey: undefined },
      { ...part('different-store'), orderKey: 'other.myshopify.com/gid://shopify/Order/123' },
      { ...part('similar'), orderKey: undefined, orderName: '#10010' },
      { ...addition('panel'), id: 'unassigned' },
    ]
    job.sheet.orderImports = [{ key: order.key, name: order.name, instanceIds: ['imported'] }]
    const result = orderCuttingSheets([job], order)
    expect(result.sheets[0]).toMatchObject({ partCount: 2, totalParts: 5 })
    expect(orderCuttingSheets([job], { key: 'unknown', name: '#100' }).sheets).toEqual([])
  })

  it('retains archived cut records while excluding removed waiting sheets and allocations', () => {
    const job = { ...newProductionJob(materialSheet()), archived: true }
    job.sheet.instances = [part('cut'), part('removed', 1)]
    job.sheet.pendingParts = [part('pending')]
    job.sheets[0] = { stage: 'cut' }
    const result = orderCuttingSheets([job], order)
    expect(result.sheets.map(sheet => sheet.stage)).toEqual(['cut'])
    expect(result.pending).toEqual([])
  })

  it('follows order parts into their new job after re-planning', () => {
    const first = newProductionJob({ ...materialSheet(), instances: [{ ...part('first'), orderKey: 'other' }] })
    const second = newProductionJob({ ...materialSheet(), instances: [part('moved')] })
    const result = replanWorkspace({ activeId: second.id, jobs: [first, second] }, [materialPart('panel')])
    const matches = orderCuttingSheets(result.jobs, order)
    expect(matches.sheets).toHaveLength(1)
    expect(matches.sheets[0]).toMatchObject({ job: { id: first.id }, partCount: 1, totalParts: 2 })
  })
})
