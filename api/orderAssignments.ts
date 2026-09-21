import { z } from 'zod'
import { JobError } from '../src/jobs/generateJob'
import type { OrderAssignment, OrderUser } from '../src/orders/types'
import type { ShopifyReader } from './shopify'

export const assignmentSchema = z.strictObject({
  assigneeId: z.uuid().nullable(),
  paymentPence: z.number().int().min(0).max(100000000).nullable(),
  expectedVersion: z.number().int().min(0).max(2147483646),
}).refine(v => (v.assigneeId === null) === (v.paymentPence === null))
export type AssignmentInput = z.infer<typeof assignmentSchema>
export interface OrderRepository {
  orderAdmin(): Promise<string | null>
  orderUsers(owner: string, offset: number): Promise<OrderUser[]>
  orderAssignments(owner: string, shop: string, ids?: string[], offset?: number, search?: string): Promise<OrderAssignment[]>
  assignOrder(owner: string, shop: string, id: string, name: string, input: AssignmentInput): Promise<void>
}

const workerParams = z.strictObject({ after: z.string().regex(/^\d{1,6}$/).optional(), status: z.literal('all').optional(), search: z.string().max(80).regex(/^[\w #.-]*$/).optional() })
export async function orderService(repo: OrderRepository, reader: ShopifyReader, owner: string) {
  const admin = await repo.orderAdmin(), isAdmin = admin === owner
  const connection = admin ? reader.connection(admin) : { connected: false }
  const shop = 'shop' in connection ? connection.shop : undefined
  const requireStore = () => { if (!admin || !shop || !connection.connected) throw new JobError('No Shopify store is connected.', 404); return { admin, shop } }
  const requireAdmin = () => { if (!isAdmin) throw new JobError('Only the order administrator can manage assignments.', 403) }
  const assignments = (ids: string[]) => repo.orderAssignments(owner, requireStore().shop, ids)
  const canRead = async (id: string) => { const rows = await assignments([id]); if (!isAdmin && !rows.some(a => a.order_id === id && a.assignee_id === owner)) throw new JobError('Order not found.', 404); return rows[0] ?? null }
  return {
    connection: { accountId: owner, connected: connection.connected, ...(shop ? { shop } : {}), isOrderAdmin: isAdmin },
    async users(params: URLSearchParams) {
      requireAdmin()
      const offset = Number(params.get('offset') ?? 0)
      if ([...params.keys()].some(k => k !== 'offset') || params.getAll('offset').length > 1 || !Number.isInteger(offset) || offset < 0 || offset > 100000) throw new JobError('Invalid user pagination.', 400)
      const users = await repo.orderUsers(owner, offset)
      return { users: users.slice(0, 100), nextOffset: users.length > 100 ? offset + 100 : null }
    },
    async orders(params: URLSearchParams) {
      const { admin, shop } = requireStore()
      if (isAdmin) {
        const result = await reader.orders(admin, params)
        const rows = result.orders.length ? await assignments(result.orders.map(o => o.id.split('/').at(-1)!)) : []
        return { ...result, orders: result.orders.map(o => ({ ...o, assignment: rows.find(a => a.order_id === o.id.split('/').at(-1)) ?? null })) }
      }
      const parsed = workerParams.safeParse(Object.fromEntries(params))
      if (!parsed.success || [...params.keys()].length !== new Set(params.keys()).size) throw new JobError('Invalid assigned-order filters.', 400)
      const offset = Number(parsed.data.after ?? 0)
      if (offset > 100000) throw new JobError('Invalid assigned-order pagination.', 400)
      const rows = await repo.orderAssignments(owner, shop, undefined, offset, parsed.data.search?.trim() ?? '')
      const ids = rows.slice(0, 25).filter(a => a.assignee_id === owner).map(a => a.order_id)
      const orders = ids.length ? await reader.ordersByIds(admin, ids) : []
      // Recheck after Shopify responds so a concurrent reassignment revokes access.
      const current = ids.length ? await assignments(ids) : []
      return { shop, fetchedAt: new Date().toISOString(), orders: orders.flatMap(o => {
        const assignment = current.find(a => a.order_id === o.id.split('/').at(-1) && a.assignee_id === owner)
        return assignment && ids.includes(assignment.order_id) ? [{ ...o, assignment }] : []
      }), pageInfo: { hasNextPage: rows.length > 25, endCursor: rows.length > 25 ? String(offset + 25) : null } }
    },
    async order(id: string, params: URLSearchParams) {
      const { admin } = requireStore()
      await canRead(id)
      const result = await reader.order(admin, id, params)
      return { ...result, order: { ...result.order, assignment: await canRead(id) } }
    },
    async assign(id: string, raw: unknown) {
      requireAdmin()
      const { admin, shop } = requireStore()
      const parsed = assignmentSchema.safeParse(raw)
      if (!parsed.success) throw new JobError('Supply assigneeId, a whole-pence GBP cutting payment and expectedVersion. Unassign with both assigneeId and paymentPence null.', 400)
      const result = await reader.order(admin, id, new URLSearchParams())
      await repo.assignOrder(owner, shop, id, result.order.name, parsed.data)
      return { assignment: await canRead(id) }
    },
  }
}
