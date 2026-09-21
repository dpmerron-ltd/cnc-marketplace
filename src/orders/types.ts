export interface ShopifyConnection { accountId: string; connected: boolean; shop?: string; isOrderAdmin?: boolean }
export interface OrderUser { id: string; email: string }
export interface OrderAssignment {
  order_id: string
  assignee_id: string | null
  assignee_email: string | null
  payment_pence: number | null
  currency: 'GBP'
  version: number
  updated_at: string
}
export interface OrderPageInfo { hasNextPage: boolean; endCursor: string | null }
export interface ShopifyOrder {
  id: string
  name: string
  assignment?: OrderAssignment | null
  lineItems: { nodes: ShopifyLineItem[]; pageInfo: OrderPageInfo }
}
export interface ShopifyLineItem {
  id: string
  title: string
  variantTitle: string | null
  sku: string | null
  quantity: number
  currentQuantity: number
  unfulfilledQuantity: number
}
export interface ShopifyOrders { shop: string; fetchedAt: string; orders: ShopifyOrder[]; pageInfo: OrderPageInfo }
export interface ShopifyOrderDetail { shop: string; fetchedAt: string; order: ShopifyOrder }
