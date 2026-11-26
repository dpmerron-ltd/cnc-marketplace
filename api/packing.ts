import type { SupabaseClient } from '@supabase/supabase-js'
import type { ShopifyReader } from './shopify'
import type { JobRepository } from './handler'
import type { SheetWorkspace } from '../src/jobs/production'
import { sheetNeedsExport } from '../src/jobs/production'
import { JobError } from '../src/jobs/generateJob'

export function cutOrderParts(workspace: SheetWorkspace, key: string): Map<string, number> | undefined {
  const counts = new Map<string, number>(), seen = new Set<string>()
  for (const job of workspace.jobs) {
    const matches = (i: typeof job.sheet.instances[number]) => (i.orderKey ?? job.sheet.orderImports?.find(o => o.instanceIds.includes(i.id))?.key) === key
    if (!job.archived && job.sheet.pendingParts?.some(matches)) return
    for (const part of job.sheet.instances.filter(matches)) {
      if(workspace.failedParts?.[part.id])continue
      if (job.archived && job.sheets[part.sheetIndex]?.stage !== 'cut') continue
      if ((job.sheets[part.sheetIndex]?.stage !== 'cut' && !job.sheets[part.sheetIndex]?.scannedPartIds?.includes(part.id)) || sheetNeedsExport(job, part.sheetIndex) || seen.has(part.id)) return
      seen.add(part.id); counts.set(part.partId, (counts.get(part.partId) ?? 0) + 1)
    }
  }
  return counts.size ? counts : undefined
}
export function unresolvedFailedOrderKeys(workspace:SheetWorkspace):Set<string> {
 const entries=workspace.jobs.flatMap(job=>job.sheet.instances.map(part=>({job,part})))
 const resolved=(recutId:string,seen=new Set<string>()):boolean=>{
  if(seen.has(recutId))return false
  const next=new Set([...seen,recutId])
  return entries.some(({job,part})=>part.recutId===recutId&&(workspace.failedParts?.[part.id]?resolved(workspace.failedParts[part.id],next):!sheetNeedsExport(job,part.sheetIndex)&&(job.sheets[part.sheetIndex]?.stage==='cut'||Boolean(job.sheets[part.sheetIndex]?.scannedPartIds?.includes(part.id)))))
 }
 return new Set(entries.flatMap(({job,part})=>{
  const recutId=workspace.failedParts?.[part.id],key=part.orderKey??job.sheet.orderImports?.find(o=>o.instanceIds.includes(part.id))?.key
  return recutId&&key&&!resolved(recutId)?[key]:[]
 }))
}

export function coversRequiredParts(cut: Map<string, number>, required: Map<string, number>) {
  return required.size > 0 && [...required].every(([id, count]) => Number.isSafeInteger(count) && count > 0 && (cut.get(id) ?? 0) >= count)
}

export function packingRuntime(db: SupabaseClient, repo: JobRepository, getShopify: () => ShopifyReader) {
  return async (owner: string, ids: string[]) => {
    const admin = await repo.orderAdmin()
    // Only the store owner can write its packing tags; worker sessions cannot cross accounts.
    if (owner !== admin) throw new JobError('Only the order administrator can sync Shopify packing tags.', 403)
    const reader = getShopify(), connection = reader.connection(owner)
    if (!connection.shop || !reader.readyToPack) throw new JobError('Shopify packing sync is unavailable.', 503)
    const load = async () => {
      const {data,error} = await db.from('sheet_projects').select('workspace,workspace_version').eq('owner_id',owner).eq('id',owner).maybeSingle()
      if (error || !data?.workspace) throw new JobError('Saved cutting progress is unavailable. Save and retry.',409)
      return data as {workspace:SheetWorkspace;workspace_version:number}
    }
    const saved = await load(), results: Array<{id:string;name?:string;tagged:boolean;retry?:boolean;message:string}> = []
    for (const id of [...new Set(ids)]) {
      try {
        const cut = cutOrderParts(saved.workspace, `${connection.shop}/gid://shopify/Order/${id}`)
        if (!cut) { results.push({id,tagged:false,message:'Parts remain uncut or completion is not verified.'}); continue }
        const detail = await reader.order(owner,id,new URLSearchParams()), order = detail.order
        const seen = new Set<string>()
        while (order.lineItems.pageInfo.hasNextPage) {
          const after = order.lineItems.pageInfo.endCursor
          if (!after || seen.has(after) || seen.size >= 20) throw Error('Could not verify every order item.')
          seen.add(after)
          const next = await reader.order(owner,id,new URLSearchParams({after}))
          order.lineItems.nodes.push(...next.order.lineItems.nodes); order.lineItems.pageInfo = next.order.lineItems.pageInfo
        }
        if (order.cancelledAt || order.closedAt) throw Error('Order is cancelled or closed; no packing tag added.')
        if(unresolvedFailedOrderKeys(saved.workspace).has(`${connection.shop}/gid://shopify/Order/${id}`))throw Error('A failed part still needs its replacement confirmed cut.')
        const required = new Map<string,number>()
        for (const line of order.lineItems.nodes.filter(l => l.currentQuantity > 0)) {
          if (!line.sku?.trim()) throw Error('An order item has no matched CNC SKU; packing readiness needs review.')
          const {data:items,error} = await db.from('marketplace_items').select('id').eq('sku',line.sku.trim()).eq('version_default',true).eq('version_status','published').limit(2)
          if (error || items?.length !== 1) throw Error('An order item is not uniquely matched to the CNC catalogue; packing readiness needs review.')
          const {data:parts,error:partError} = await db.from('cnc_components').select('id').eq('item_id',items[0].id).limit(1001)
          if (partError || !parts?.length || parts.length > 1000) throw Error('Could not verify the complete component list.')
          for (const part of parts) required.set(part.id,(required.get(part.id)??0)+line.currentQuantity)
        }
        if (!coversRequiredParts(cut,required)) throw Error('Not all required components and quantities are confirmed cut against the current order and catalogue.')
        if ((await load()).workspace_version !== saved.workspace_version) throw Error('Cutting progress changed during the check. Retry packing sync.')
        await reader.readyToPack(owner,id)
        results.push({id,name:order.name,tagged:true,message:'Ready to pack'})
      } catch(error) { results.push({id,tagged:false,retry:true,message:error instanceof Error?error.message:'Packing sync failed. Retry.'}) }
    }
    return {results}
  }
}
