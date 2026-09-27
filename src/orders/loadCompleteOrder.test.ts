import { beforeEach, expect, it, vi } from 'vitest'
import { loadCompleteOrder } from './loadCompleteOrder'
const request = vi.hoisted(() => vi.fn())
vi.mock('../storage/jobsApi', () => ({ jobApiRequest: request }))
const page = (id: string, next: string | null = null) => ({ shop: 'test.myshopify.com', order: { id: 'gid://shopify/Order/123', lineItems: { nodes: [{ id }], pageInfo: { hasNextPage: Boolean(next), endCursor: next } } } })
const response = (body: unknown) => ({ json: async () => body })
beforeEach(() => { request.mockReset() })
it('loads all authorized pages and deduplicates lines', async () => {
  request.mockResolvedValueOnce(response(page('a', 'next'))).mockResolvedValueOnce(response(page('b')))
  const result = await loadCompleteOrder('alice', '123', new AbortController().signal)
  expect(result.order.lineItems.nodes.map(l => l.id)).toEqual(['a', 'b'])
  expect(request).toHaveBeenLastCalledWith('/shopify/orders/123?after=next', 'alice', expect.anything())
})
it('rejects pagination loops, changed orders, and authorization failures', async () => {
  request.mockResolvedValue(response(page('a', 'repeat')))
  await expect(loadCompleteOrder('alice', '123', new AbortController().signal)).rejects.toThrow('complete order')
  request.mockResolvedValue(response(page('a')))
  await expect(loadCompleteOrder('alice', '999', new AbortController().signal)).rejects.toThrow('Order changed')
  request.mockImplementation(async () => { throw new Error('Forbidden') })
  await expect(loadCompleteOrder('alice', '123', new AbortController().signal)).rejects.toThrow('Forbidden')
})
