// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { orderService, type OrderRepository } from './orderAssignments'
import type { ShopifyReader } from './shopify'
import type { OrderAssignment } from '../src/orders/types'

const dan = '00000000-0000-4000-8000-000000000001', bob = '00000000-0000-4000-8000-000000000002'
const shop = 'test.myshopify.com', pageInfo = { hasNextPage: false, endCursor: null }
const order = (id = '123') => ({ id: `gid://shopify/Order/${id}`, name: '#1007', lineItems: { nodes: [], pageInfo } })
const assignment = (id = '123'): OrderAssignment => ({ order_id: id, assignee_id: bob, assignee_email: null, payment_pence: 4500, currency: 'GBP', version: 1, updated_at: '2026-09-21' })
function fixture() {
  let rows: OrderAssignment[] = [assignment()]
  const repo: OrderRepository = {
    orderAdmin: vi.fn(async () => dan),
    orderUsers: vi.fn(async () => [{ id: bob, email: 'bob@example.com' }]),
    orderAssignments: vi.fn(async (owner, _shop, ids) => rows.filter(a => (owner === dan || a.assignee_id === owner) && (!ids || ids.includes(a.order_id)))),
    assignOrder: vi.fn(async () => {}),
  }
  const reader: ShopifyReader = {
    connection: vi.fn(owner => ({ accountId: owner, connected: owner === dan, shop })),
    orders: vi.fn(async () => ({ shop, orders: [order(), order('456')], pageInfo, fetchedAt: '' })),
    order: vi.fn(async (_owner, id) => ({ shop, order: order(id), fetchedAt: '' })),
    ordersByIds: vi.fn(async (_owner: string, ids: string[]) => ids.map(id => order(id))),
  }
  return { repo, reader, setRows: (next: OrderAssignment[]) => { rows = next } }
}

describe('order assignment authorization', () => {
  it('gives the pinned admin all orders, including unassigned orders', async () => {
    const f = fixture(), service = await orderService(f.repo, f.reader, dan)
    expect(service.connection.isOrderAdmin).toBe(true)
    const result = await service.orders(new URLSearchParams({ status: 'all' }))
    expect(result.orders.map(o => o.id)).toEqual([order().id, order('456').id])
    expect(result.orders[1].assignment).toBeNull()
    expect(f.reader.orders).toHaveBeenCalledWith(dan, expect.any(URLSearchParams))
  })
  it('only retrieves assigned IDs for workers via the admin store, not their own connection', async () => {
    const f = fixture(), service = await orderService(f.repo, f.reader, bob)
    const result = await service.orders(new URLSearchParams({ status: 'all' }))
    expect(result.orders).toHaveLength(1)
    expect(result.orders[0].assignment?.payment_pence).toBe(4500)
    expect(f.reader.orders).not.toHaveBeenCalled()
    expect(f.reader.ordersByIds).toHaveBeenCalledWith(dan, ['123'])
    expect(service.connection).toEqual({ accountId: bob, connected: true, isOrderAdmin: false, shop })
  })
  it('returns no orders or Shopify request when none are assigned', async () => {
    const f = fixture(); f.setRows([])
    const service = await orderService(f.repo, f.reader, bob)
    expect((await service.orders(new URLSearchParams())).orders).toEqual([])
    expect(f.reader.ordersByIds).not.toHaveBeenCalled()
  })
  it('blocks guessed order IDs including detail pagination before contacting Shopify', async () => {
    const f = fixture(), service = await orderService(f.repo, f.reader, bob)
    await expect(service.order('456', new URLSearchParams({ after: 'cursor' }))).rejects.toMatchObject({ status: 404 })
    expect(f.reader.order).not.toHaveBeenCalled()
    expect((await service.order('123', new URLSearchParams())).order.assignment?.payment_pence).toBe(4500)
  })
  it('rejects worker assignment and user enumeration without reading Shopify or writing', async () => {
    const f = fixture(), service = await orderService(f.repo, f.reader, bob)
    await expect(service.assign('123', { assigneeId: bob, paymentPence: 1, expectedVersion: 1 })).rejects.toMatchObject({ status: 403 })
    await expect(service.users(new URLSearchParams())).rejects.toMatchObject({ status: 403 })
    expect(f.reader.order).not.toHaveBeenCalled()
    expect(f.repo.assignOrder).not.toHaveBeenCalled()
    expect(f.repo.orderUsers).not.toHaveBeenCalled()
  })
  it('records the fee in integer pence using the server order name and expected version', async () => {
    const f = fixture(), service = await orderService(f.repo, f.reader, dan)
    const input = { assigneeId: bob, paymentPence: 12345, expectedVersion: 1 }
    await service.assign('123', input)
    expect(f.repo.assignOrder).toHaveBeenCalledWith(dan, shop, '123', '#1007', input)
    await service.assign('123', { assigneeId: null, paymentPence: null, expectedVersion: 2 })
    expect(f.repo.assignOrder).toHaveBeenLastCalledWith(dan, shop, '123', '#1007', { assigneeId: null, paymentPence: null, expectedVersion: 2 })
  })
  it.each([
    { assigneeId: bob, paymentPence: null, expectedVersion: 0 },
    { assigneeId: null, paymentPence: 500, expectedVersion: 0 },
    { assigneeId: bob, paymentPence: -1, expectedVersion: 0 },
    { assigneeId: bob, paymentPence: 10.5, expectedVersion: 0 },
    { assigneeId: bob, paymentPence: 100000001, expectedVersion: 0 },
    { assigneeId: bob, paymentPence: 100, expectedVersion: 0, ownerId: dan },
    { assigneeId: bob, paymentPence: 100 },
  ])('rejects invalid assignment input %j', async input => {
    const f = fixture(), service = await orderService(f.repo, f.reader, dan)
    await expect(service.assign('123', input)).rejects.toMatchObject({ status: 400 })
    expect(f.repo.assignOrder).not.toHaveBeenCalled()
  })
  it('revokes detail and list access if reassigned while Shopify responds', async () => {
    const f = fixture(), service = await orderService(f.repo, f.reader, bob)
    vi.mocked(f.reader.order).mockImplementation(async () => { f.setRows([]); return { shop, order: order(), fetchedAt: '' } })
    await expect(service.order('123', new URLSearchParams())).rejects.toMatchObject({ status: 404 })
    f.setRows([assignment()])
    vi.mocked(f.reader.ordersByIds).mockImplementation(async () => { f.setRows([]); return [order()] })
    expect((await service.orders(new URLSearchParams())).orders).toEqual([])
  })
  it('paginates assigned IDs and rejects forged worker filters', async () => {
    const f = fixture(); f.setRows(Array.from({ length: 26 }, (_, i) => assignment(String(i))))
    const service = await orderService(f.repo, f.reader, bob)
    const result = await service.orders(new URLSearchParams({ search: '#1007', after: '25' }))
    expect(result.orders).toHaveLength(25)
    expect(result.pageInfo).toEqual({ hasNextPage: true, endCursor: '50' })
    expect(f.repo.orderAssignments).toHaveBeenCalledWith(bob, shop, undefined, 25, '#1007')
    for (const query of ['ownerId=admin', 'after=-1', 'status=open', 'after=1&after=2']) await expect(service.orders(new URLSearchParams(query))).rejects.toMatchObject({ status: 400 })
  })
  it('fails closed when no admin has been configured', async () => {
    const f = fixture(); vi.mocked(f.repo.orderAdmin).mockResolvedValue(null)
    const service = await orderService(f.repo, f.reader, bob)
    expect(service.connection.connected).toBe(false)
    await expect(service.orders(new URLSearchParams())).rejects.toMatchObject({ status: 404 })
  })
})
