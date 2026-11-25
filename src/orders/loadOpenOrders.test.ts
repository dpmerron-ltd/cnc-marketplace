import { beforeEach, expect, it, vi } from 'vitest'
import { loadOpenOrders } from './loadOpenOrders'
const request = vi.hoisted(() => vi.fn())
vi.mock('../storage/jobsApi', () => ({ jobApiRequest: request }))
const order = (id: string) => ({
  id: `gid://shopify/Order/${id}`,
  name: `#${id}`,
  createdAt: '2026-11-20T00:00:00Z',
  lineItems: { nodes: [{ id: 'line', unfulfilledQuantity: 1 }], pageInfo: { hasNextPage: false, endCursor: null } }
})
const page = (orders: unknown[], endCursor: string | null = null) => ({
  shop: 'shop',
  orders,
  pageInfo: { hasNextPage: Boolean(endCursor), endCursor }
})
beforeEach(() => {
  request.mockReset()
  request.mockResolvedValueOnce(Response.json({ connected: true, isOrderAdmin: true }))
})
it('loads every order page and all line-item pages', async () => {
  const first = {
    ...order('1'),
    lineItems: { nodes: [{ id: 'line', unfulfilledQuantity: 1 }], pageInfo: { hasNextPage: true, endCursor: 'line2' } }
  }
  request
    .mockResolvedValueOnce(Response.json(page([first], 'next')))
    .mockResolvedValueOnce(Response.json({ shop: 'shop', order: order('1') }))
    .mockResolvedValueOnce(Response.json(page([order('2')])))
  const progress = vi.fn()
  const result = await loadOpenOrders('owner', new AbortController().signal, progress)
  expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ percent: 20, message: 'Loaded 2 open orders' })
  expect(progress.mock.calls.some(([p]) => p.message.includes('page 2'))).toBe(true)
  expect(result.orders.map((o) => o.name)).toEqual(['#1', '#2'])
  expect(request.mock.calls[1][0]).toContain('status=unfulfilled')
  expect(request.mock.calls[3][0]).toContain('after=next')
})
it('refuses repeated cursors instead of silently planning a partial backlog', async () => {
  request.mockImplementation(async () => Response.json(page([order('1')], 'same')))
  await expect(loadOpenOrders('owner', new AbortController().signal)).rejects.toThrow('all open orders')
})
it('cancels without requesting orders', async () => {
  const abort = new AbortController()
  abort.abort()
  await expect(loadOpenOrders('owner', abort.signal)).rejects.toThrow()
  expect(request).not.toHaveBeenCalled()
})
