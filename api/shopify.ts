import { z } from 'zod'
import { JobError } from '../src/jobs/generateJob'
import type { ShopifyConnection, ShopifyOrder, ShopifyOrderDetail, ShopifyOrders } from '../src/orders/types'

const connectionSchema = z.strictObject({
  ownerId: z.uuid(), shop: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
  clientId: z.string().min(1).max(200), clientSecret: z.string().min(1).max(500),
})
const connectionsSchema = z.array(connectionSchema).max(100).refine(rows => new Set(rows.map(r => r.ownerId)).size === rows.length)
type Connection = z.infer<typeof connectionSchema>
const cursor = z.string().min(1).max(2048).optional()
const listParams = z.strictObject({ after: cursor, status: z.enum(['all', 'open', 'unfulfilled', 'fulfilled', 'cancelled']).default('open'), search: z.string().max(80).regex(/^[\w #.-]*$/).default('') })
const detailParams = z.strictObject({ after: cursor })
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }).refine(p => !p.hasNextPage || Boolean(p.endCursor))
const lineItem = z.object({ id: z.string(), title: z.string(), variantTitle: z.string().nullable(), sku: z.string().nullable(), quantity: z.number().int().nonnegative(), currentQuantity: z.number().int().nonnegative(), unfulfilledQuantity: z.number().int().nonnegative() })
const order = z.object({ id: z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/), name: z.string(), lineItems: z.object({ nodes: z.array(lineItem), pageInfo }) })
const itemFields = 'nodes { id title variantTitle sku quantity currentQuantity unfulfilledQuantity } pageInfo { hasNextPage endCursor }'
const listQuery = `query CncOrders($after: String, $query: String!) { orders(first: 25, after: $after, sortKey: CREATED_AT, reverse: true, query: $query) { nodes { id name lineItems(first: 5) { ${itemFields} } } pageInfo { hasNextPage endCursor } } }`
const detailQuery = `query CncOrder($id: ID!, $after: String) { order(id: $id) { id name lineItems(first: 100, after: $after) { ${itemFields} } } }`
const filters = { all: '', open: 'status:open', unfulfilled: 'status:open (fulfillment_status:unfulfilled OR fulfillment_status:partial)', fulfilled: 'fulfillment_status:fulfilled', cancelled: 'status:cancelled' }

export interface ShopifyReader {
  connection(owner: string): ShopifyConnection
  orders(owner: string, params: URLSearchParams): Promise<ShopifyOrders>
  order(owner: string, id: string, params: URLSearchParams): Promise<ShopifyOrderDetail>
  ordersByIds(owner: string, ids: string[]): Promise<ShopifyOrder[]>
}

export function shopifyReader(raw = '[]', fetcher: typeof fetch = fetch, now = Date.now): ShopifyReader {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Invalid server Shopify configuration.') }
  const config = connectionsSchema.safeParse(parsed)
  if (!config.success) throw new Error('Invalid server Shopify configuration.')
  const connections = new Map(config.data.map(c => [c.ownerId, c]))
  const tokens = new Map<string, { token: string; expires: number }>()
  const pending = new Map<string, Promise<string>>()
  const get = (owner: string) => {
    const connection = connections.get(owner)
    if (!connection) throw new JobError('No Shopify store is connected to this account.', 404)
    return connection
  }
  async function request(url: string, init: RequestInit) {
    try { return await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) }) }
    catch { throw new JobError('Shopify is unavailable. Please retry.', 502) }
  }
  async function token(c: Connection): Promise<string> {
    const cached = tokens.get(c.ownerId)
    if (cached && cached.expires > now() + 60000) return cached.token
    const existing = pending.get(c.ownerId)
    if (existing) return existing
    const task = (async () => {
      const response = await request(`https://${c.shop}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret }) })
      if (response.status === 429) throw new JobError('Shopify rate limit reached. Retry shortly.', 429)
      if (!response.ok) throw new JobError('Shopify app authentication failed. Check the server connection credentials and app installation.', 502)
      const result = z.object({ access_token: z.string().min(1), expires_in: z.number().positive(), scope: z.string() }).safeParse(await response.json().catch(() => null))
      if (!result.success) throw new JobError('Shopify returned an invalid authentication response.', 502)
      if (!result.data.scope.split(',').some(scope => ['read_orders', 'write_orders'].includes(scope.trim()))) throw new JobError('The Shopify app needs read_orders access. Update its scopes and installation.', 403)
      tokens.set(c.ownerId, { token: result.data.access_token, expires: now() + result.data.expires_in * 1000 })
      return result.data.access_token
    })()
    pending.set(c.ownerId, task)
    try { return await task } finally { pending.delete(c.ownerId) }
  }
  async function graphql(c: Connection, query: string, variables: unknown) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const accessToken = await token(c)
      const response = await request(`https://${c.shop}/admin/api/2026-07/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken }, body: JSON.stringify({ query, variables }) })
      if (response.status === 401 && attempt === 0) { tokens.delete(c.ownerId); continue }
      if (response.status === 429) throw new JobError('Shopify rate limit reached. Retry shortly.', 429)
      if (response.status === 403) throw new JobError('Shopify denied order access. Check the app permissions.', 403)
      if (!response.ok) throw new JobError('Shopify could not load orders. Please retry.', 502)
      const result = z.object({ data: z.unknown().optional(), errors: z.array(z.object({ extensions: z.object({ code: z.string().optional() }).optional() })).optional() }).safeParse(await response.json().catch(() => null))
      if (!result.success) throw new JobError('Shopify returned an invalid response.', 502)
      if (result.data.errors?.length) {
        if (result.data.errors.some(e => e.extensions?.code === 'THROTTLED')) throw new JobError('Shopify rate limit reached. Retry shortly.', 429)
        if (result.data.errors.some(e => e.extensions?.code === 'ACCESS_DENIED')) throw new JobError('Shopify denied order access. Check read_orders and protected order data permissions.', 403)
        throw new JobError('Shopify could not load complete order data. Check app access and retry.', 502)
      }
      return result.data.data
    }
    throw new JobError('Shopify authentication failed. Reconnect the app.', 502)
  }
  function params<T>(schema: z.ZodType<T>, values: URLSearchParams): T {
    const result = schema.safeParse(Object.fromEntries(values))
    if (!result.success || [...values.keys()].length !== new Set(values.keys()).size) throw new JobError('Invalid Shopify filters or pagination.', 400)
    return result.data
  }
  return {
    connection(owner) { const c = connections.get(owner); return { accountId: owner, connected: Boolean(c), ...(c ? { shop: c.shop } : {}) } },
    async ordersByIds(owner, ids) {
      const c = get(owner)
      if (!ids.length || ids.length > 25 || ids.some(id => !/^\d{1,30}$/.test(id))) throw new JobError('Invalid assigned order IDs.', 400)
      const gids = ids.map(id => `gid://shopify/Order/${id}`)
      const query = `query CncAssignedOrders($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id name lineItems(first: 5) { ${itemFields} } } } }`
      const result = z.object({ nodes: z.array(order.nullable()) }).safeParse(await graphql(c, query, { ids: gids }))
      if (!result.success || result.data.nodes.some(o => o && !gids.includes(o.id))) throw new JobError('Shopify returned unexpected assigned orders.', 502)
      return result.data.nodes.flatMap(o => o ? [o] : [])
    },
    async orders(owner, values) {
      const c = get(owner), input = params(listParams, values)
      const query = [filters[input.status], input.search.trim() ? `name:"${input.search.trim()}"` : ''].filter(Boolean).join(' ')
      const result = z.object({ orders: z.object({ nodes: z.array(order), pageInfo }) }).safeParse(await graphql(c, listQuery, { after: input.after ?? null, query }))
      if (!result.success) throw new JobError('Shopify returned incomplete orders. Please retry.', 502)
      return { shop: c.shop, fetchedAt: new Date(now()).toISOString(), orders: result.data.orders.nodes, pageInfo: result.data.orders.pageInfo }
    },
    async order(owner, id, values) {
      const c = get(owner), input = params(detailParams, values)
      if (!/^\d{1,30}$/.test(id)) throw new JobError('Invalid Shopify order ID.', 400)
      const result = z.object({ order: order.nullable() }).safeParse(await graphql(c, detailQuery, { id: `gid://shopify/Order/${id}`, after: input.after ?? null }))
      if (!result.success) throw new JobError('Shopify returned incomplete order details. Please retry.', 502)
      if (!result.data.order) throw new JobError('Order not found or outside the Shopify app access window.', 404)
      if (result.data.order.id !== `gid://shopify/Order/${id}`) throw new JobError('Shopify returned an unexpected order.', 502)
      return { shop: c.shop, fetchedAt: new Date(now()).toISOString(), order: result.data.order }
    },
  }
}
