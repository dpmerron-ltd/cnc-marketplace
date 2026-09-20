// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { shopifyReader } from './shopify'

const alice = '00000000-0000-4000-8000-000000000001', bob = '00000000-0000-4000-8000-000000000002'
const config = [{ ownerId: alice, shop: 'test-shop.myshopify.com', clientId: 'app-id', clientSecret: 'test-secret' }]
const pageInfo = { hasNextPage: false, endCursor: null }
const order = { id: 'gid://shopify/Order/123', name: '#1001', lineItems: { nodes: [{ id: 'line1', title: 'Rack', variantTitle: '12 mm', sku: 'RACK', quantity: 2, currentQuantity: 1, unfulfilledQuantity: 1 }], pageInfo } }
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
function fixture() {
  const fetcher = vi.fn<typeof fetch>(async (url, options) => String(url).endsWith('access_token') ? response({ access_token: 'short-lived-token', expires_in: 86400, scope: 'read_orders' }) : response({ data: JSON.parse(String(options?.body)).query.includes('CncOrders(') ? { orders: { nodes: [order], pageInfo } } : { order } }))
  const clock = { now: 100000 }
  return { fetcher, clock, reader: shopifyReader(JSON.stringify(config), fetcher, () => clock.now) }
}
describe('Shopify order access', () => {
  it('never contacts Shopify for another account or exposes its credentials/store', async () => {
    const { reader, fetcher } = fixture()
    expect(reader.connection(bob)).toEqual({ accountId: bob, connected: false })
    await expect(reader.orders(bob, new URLSearchParams())).rejects.toMatchObject({ status: 404 })
    await expect(reader.order(bob, '123', new URLSearchParams())).rejects.toMatchObject({ status: 404 })
    expect(fetcher).not.toHaveBeenCalled()
    expect(reader.connection(alice)).toEqual({ accountId: alice, connected: true, shop: config[0].shop })
  })
  it('rejects unsafe configuration, duplicate ownership and client-supplied shop/owner', async () => {
    for (const shop of ['http://localhost', 'test.myshopify.com.evil.com', 'test.myshopify.com/path', 'test.myshopify.com:8080', 'test@evil.com']) expect(() => shopifyReader(JSON.stringify([{ ...config[0], shop }]))).toThrow('Invalid server')
    expect(() => shopifyReader(JSON.stringify([...config, ...config]))).toThrow('Invalid server')
    const { reader, fetcher } = fixture()
    for (const query of ['shop=evil.myshopify.com', 'ownerId=' + bob, 'search=x%22%20OR%20status%3Aany', 'status=open&status=all', 'status=nope', 'after=']) await expect(reader.orders(alice, new URLSearchParams(query))).rejects.toMatchObject({ status: 400 })
    await expect(reader.order(alice, '../123', new URLSearchParams())).rejects.toMatchObject({ status: 400 })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('reads only order numbers/items, forwards cursors, caches and renews expiring tokens', async () => {
    const { reader, fetcher, clock } = fixture()
    const result = await reader.orders(alice, new URLSearchParams('status=unfulfilled&search=%231001&after=abc'))
    expect(result.orders).toEqual([order])
    expect(await reader.order(alice, '123', new URLSearchParams('after=lines2'))).toMatchObject({ order })
    expect(fetcher).toHaveBeenCalledTimes(3)
    const sent = fetcher.mock.calls.filter(([url]) => String(url).endsWith('graphql.json')).map(([, options]) => JSON.parse(String(options?.body)))
    expect(sent[0].variables).toEqual({ after: 'abc', query: 'status:open (fulfillment_status:unfulfilled OR fulfillment_status:partial) name:"#1001"' })
    expect(sent[1].variables).toEqual({ id: order.id, after: 'lines2' })
    for (const request of sent) expect(request.query).not.toMatch(/price|total|money|customer|email|address|mutation/i)
    for (const [, options] of fetcher.mock.calls) expect(options?.redirect).toBe('error')
    clock.now += 86400000
    await reader.orders(alice, new URLSearchParams())
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('access_token'))).toHaveLength(2)
  })
  it('drops unexpected pricing/customer fields from upstream data', async () => {
    const { reader, fetcher } = fixture()
    fetcher.mockResolvedValueOnce(response({ access_token: 'token', expires_in: 86400, scope: 'read_orders' })).mockResolvedValueOnce(response({ data: { orders: { nodes: [{ ...order, totalPrice: 'secret-price', customer: { email: 'private' } }], pageInfo } } }))
    expect(JSON.stringify(await reader.orders(alice, new URLSearchParams()))).not.toMatch(/secret-price|private|totalPrice|customer/)
  })
  it('renews once after a revoked token and does not retry forbidden responses', async () => {
    const { reader, fetcher } = fixture()
    fetcher.mockResolvedValueOnce(response({ access_token: 'old', expires_in: 86400, scope: 'read_orders' })).mockResolvedValueOnce(response({}, 401))
    await reader.orders(alice, new URLSearchParams())
    expect(fetcher).toHaveBeenCalledTimes(4)
    fetcher.mockResolvedValueOnce(response({ secret: 'never expose' }, 403))
    await expect(reader.orders(alice, new URLSearchParams())).rejects.toMatchObject({ status: 403 })
  })
  it('reports missing scopes, throttling, absent orders and partial GraphQL failures without leaking payloads', async () => {
    const f = fixture()
    f.fetcher.mockResolvedValueOnce(response({ access_token: 'token', expires_in: 86400, scope: 'read_products' }))
    await expect(f.reader.orders(alice, new URLSearchParams())).rejects.toMatchObject({ status: 403 })
    await f.reader.orders(alice, new URLSearchParams())
    f.fetcher.mockResolvedValueOnce(response({ data: { order: null } }))
    await expect(f.reader.order(alice, '123', new URLSearchParams())).rejects.toMatchObject({ status: 404 })
    f.fetcher.mockResolvedValueOnce(response({ data: { orders: { nodes: [order], pageInfo } }, errors: [{ message: 'SECRET', extensions: { code: 'THROTTLED' } }] }))
    await expect(f.reader.orders(alice, new URLSearchParams())).rejects.toMatchObject({ status: 429 })
    f.fetcher.mockResolvedValueOnce(response({ errors: [{ message: 'SECRET' }] }))
    await expect(f.reader.orders(alice, new URLSearchParams())).rejects.toThrow('complete order data')
  })
})
