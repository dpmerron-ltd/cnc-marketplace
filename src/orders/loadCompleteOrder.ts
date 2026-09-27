import { jobApiRequest } from '../storage/jobsApi'
import type { ShopifyOrderDetail } from './types'

export async function loadCompleteOrder(userId: string, orderId: string, signal: AbortSignal): Promise<ShopifyOrderDetail> {
  let result: ShopifyOrderDetail | undefined
  const lines = new Map<string, ShopifyOrderDetail['order']['lineItems']['nodes'][number]>()
  const cursors = new Set<string>()
  let after = ''
  do {
    signal.throwIfAborted()
    const page: ShopifyOrderDetail = await (await jobApiRequest(`/shopify/orders/${encodeURIComponent(orderId)}${after ? `?after=${encodeURIComponent(after)}` : ''}`, userId, { signal })).json()
    signal.throwIfAborted()
    if (page.order.id.split('/').at(-1) !== orderId || (result && result.shop !== page.shop)) throw new Error('Order changed while loading. Try again.')
    result = page
    for (const line of page.order.lineItems.nodes) lines.set(line.id, line)
    const info = page.order.lineItems.pageInfo
    after = info.hasNextPage ? info.endCursor ?? '' : ''
    if (info.hasNextPage && (!after || cursors.has(after) || cursors.size >= 100)) throw new Error('Could not load the complete order. Try again.')
    cursors.add(after)
  } while (after)
  return { ...result!, order: { ...result!.order, lineItems: { nodes: [...lines.values()], pageInfo: { hasNextPage: false, endCursor: null } } } }
}
