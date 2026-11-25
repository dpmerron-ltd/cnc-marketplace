import type { Sheet } from '../models/Sheet'
/** Recalling history creates new physical copies, not the original labelled parts. */
export function copyPartIdentities(sheet: Sheet): Sheet {
  const all = [...sheet.instances, ...(sheet.pendingParts ?? [])]
  const ids = new Map(all.map(instance => [instance.id, crypto.randomUUID()]))
  const copy = (instance: Sheet['instances'][number]) => ({
    ...instance,
    id: ids.get(instance.id)!,
    recutId: undefined,
    sharedEdgePartnerId: instance.sharedEdgePartnerId ? ids.get(instance.sharedEdgePartnerId) : undefined,
  })
  return {
    ...sheet,
    instances: sheet.instances.map(copy),
    pendingParts: sheet.pendingParts?.map(copy),
    orderImports: sheet.orderImports?.map(order => ({ ...order, instanceIds: order.instanceIds.flatMap(id => ids.has(id) ? [ids.get(id)!] : []) })),
  }
}
