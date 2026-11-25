import type { ReportPlanningProgress } from '../jobs/planningProgress'
import { jobApiRequest } from '../storage/jobsApi'
import { loadCompleteOrder } from './loadCompleteOrder'
import type { ShopifyConnection, ShopifyOrders } from './types'

/** Fetch every page; never plan from just the currently visible order page. */
export async function loadOpenOrders(userId: string, signal: AbortSignal, onProgress?: ReportPlanningProgress) {
  onProgress?.({ percent: 0, message: 'Connecting to your orders…' })
  signal.throwIfAborted()
  const connection: ShopifyConnection = await (await jobApiRequest('/shopify/connection', userId, { signal })).json()
  if (!connection.connected) throw new Error('Connect a Shopify store before planning cuts.')
  let after = '',
    shop = ''
  const seen = new Set<string>(),
    orders = new Map<string, ShopifyOrders['orders'][number]>()
  let pageNumber = 0
  do {
    pageNumber++
    onProgress?.({ percent: 20 * (1 - 1 / pageNumber), message: `Loading open orders, page ${pageNumber}…` })
    signal.throwIfAborted()
    const page: ShopifyOrders = await (
      await jobApiRequest(
        `/shopify/orders?${new URLSearchParams({ status: connection.isOrderAdmin ? 'unfulfilled' : 'all', ...(after ? { after } : {}) })}`,
        userId,
        { signal }
      )
    ).json()
    if (shop && page.shop !== shop) throw new Error('Store changed while loading orders. Try again.')
    shop = page.shop
    for (const order of page.orders) {
      onProgress?.({ percent: 20 * (1 - 1 / pageNumber), message: `Loading order details: ${order.name}` })
      const complete = order.lineItems.pageInfo.hasNextPage
        ? await loadCompleteOrder(userId, order.id.split('/').at(-1)!, signal)
        : { shop, order }
      if (complete.shop !== shop) throw new Error('Store changed while loading orders.')
      if (
        !complete.order.cancelledAt &&
        !complete.order.closedAt &&
        complete.order.lineItems.nodes.some((line) => line.unfulfilledQuantity > 0)
      )
        orders.set(order.id, complete.order)
    }
    after = page.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? '') : ''
    if (page.pageInfo.hasNextPage && (!after || seen.has(after) || seen.size >= 1000))
      throw new Error('Could not load all open orders. No plan was created.')
    seen.add(after)
  } while (after)
  onProgress?.({ percent: 20, message: `Loaded ${orders.size} open orders` })
  return { shop, orders: [...orders.values()] }
}
