import type { SupabaseClient } from '@supabase/supabase-js'
import { sheetSignature, type SheetWorkspace } from '../src/jobs/production'
import { packingRuntime, unresolvedFailedOrderKeys, cutOrderParts } from './packing'
import type { JobRepository } from './handler'
import type { ShopifyReader } from './shopify'

export function recordCut(workspace:SheetWorkspace,id:string) {
 const matches=workspace.jobs.flatMap(job=>job.sheet.instances.filter(p=>p.id===id).map(part=>({job,part})))
 if(matches.length!==1)throw Error('Part not found uniquely in the saved cutting plan. Refresh the plan or use its current label.')
 const {job,part}=matches[0], state=job.sheets[part.sheetIndex]
 if(workspace.failedParts?.[id])throw Error('This part failed. Scan the replacement’s new QR label after re-cutting it.')
 if((!job.sheets[part.sheetIndex]?.runId||job.sheets[part.sheetIndex]?.signature!==sheetSignature(job.sheet,part.sheetIndex)))throw Error('Export the current sheet before confirming this part cut.')
 const already=state.stage==='cut'||Boolean(state.scannedPartIds?.includes(id))
 const ids=[...new Set([...(state.scannedPartIds??[]),id])]
 job.sheets[part.sheetIndex]={...state,scannedPartIds:ids,stage:state.stage==='cut'||job.sheet.instances.filter(p=>p.sheetIndex===part.sheetIndex).every(p=>ids.includes(p.id)||workspace.failedParts?.[p.id])?'cut':'cutting'}
 return {already,job,part,key:part.orderKey??job.sheet.orderImports?.find(o=>o.instanceIds.includes(id))?.key}
}
export function scanRuntime(db:SupabaseClient,owner:string,repo:JobRepository,getShopify:()=>ShopifyReader){
 const load=async()=>{const {data,error}=await db.from('sheet_projects').select('workspace,workspace_version').eq('owner_id',owner).eq('id',owner).single();if(error||!data?.workspace)throw Error('Saved cutting plan unavailable.');return data as {workspace:SheetWorkspace;workspace_version:number}}
 const save=async(saved:Awaited<ReturnType<typeof load>>)=>{saved.workspace.updatedAt=new Date().toISOString();const {data,error}=await db.from('sheet_projects').update({workspace:saved.workspace,workspace_version:saved.workspace_version+1}).eq('owner_id',owner).eq('id',owner).eq('workspace_version',saved.workspace_version).select('id');if(error)throw Error('Could not save scan. Reload and retry.');return Boolean(data?.length)}
 const sync=packingRuntime(db,repo,getShopify)
 return async(id:string,failed:boolean,alert:(name:string)=>Promise<void>)=>{
  if(await repo.orderAdmin()!==owner)throw Error('Only the workshop order administrator can record scans.')
  let result:ReturnType<typeof recordCut>|undefined, key:string|undefined, recutId:string|undefined
  for(let attempt=0;attempt<5;attempt++){
   const saved=await load(), w=saved.workspace
   if(!failed){result=recordCut(w,id);key=result.key;recutId=result.part.recutId}
   else {
    const matches=w.jobs.flatMap(job=>job.sheet.instances.filter(p=>p.id===id).map(part=>({job,part})))
    if(matches.length!==1)throw Error('Failed part not found uniquely in the saved plan.')
    const {job,part}=matches[0];key=part.orderKey??job.sheet.orderImports?.find(o=>o.instanceIds.includes(id))?.key
    if((!job.sheets[part.sheetIndex]?.runId||job.sheets[part.sheetIndex]?.signature!==sheetSignature(job.sheet,part.sheetIndex)))throw Error('This label does not match the latest exported sheet.')
    let entry=w.failedParts?.[id]
    if(entry&&w.jobs.some(j=>j.sheet.instances.some(p=>p.recutId===entry&&!w.failedParts?.[p.id]&&(j.sheets[p.sheetIndex]?.stage==='cut'||j.sheets[p.sheetIndex]?.scannedPartIds?.includes(p.id)))))return '🔁 This failed part already has a completed replacement. Use the replacement label for any further failure.' 
    if(!entry){
     const source={owner_id:owner,source_run_id:job.sheets[part.sheetIndex].runId!,sheet_index:part.sheetIndex,part_number:`P${String(part.partNumber).padStart(3,'0')}`}
     let queued=await db.from('cnc_machine_recuts').insert(source).select('id').single()
     if(queued.error?.code==='23505')queued=await db.from('cnc_machine_recuts').select('id').match(source).eq('status','queued').single()
     if(queued.error||!queued.data)throw Error('Could not queue the exact exported part. Retry the failed scan.')
     entry=queued.data.id
    }
    w.failedParts={...w.failedParts,[id]:entry!}
    if(key&&w.packingAlerts)delete w.packingAlerts[key]
    // Freeze the physical export; failed parts remain recorded, replacements get new IDs.
    const state=job.sheets[part.sheetIndex]
    job.sheets[part.sheetIndex]={...state,failedPartIds:[...new Set([...(state.failedPartIds??[]),id])],stage:state.stage==='cut'||job.sheet.instances.filter(p=>p.sheetIndex===part.sheetIndex).every(p=>state.scannedPartIds?.includes(p.id)||w.failedParts?.[p.id])?'cut':'cutting'}
   }
   if(await save(saved))break
   if(attempt===4)throw Error('Another scan changed the plan. Please retry.')
  }
  const orderId=key?.match(/\/gid:\/\/shopify\/Order\/(\d+)$/)?.[1]
  if(failed){if(orderId){try{await getShopify().removeReadyToPack?.(owner,orderId)}catch{throw Error('Part queued for re-cut. Shopify tag removal failed — retry this failed scan before packing.')}}return '🔁 Failed part queued for re-cut. Add it from the Re-cut queue, then scan the replacement’s new QR when cut.'}
  if(recutId){const {error}=await db.from('cnc_machine_recuts').update({status:'completed'}).eq('owner_id',owner).eq('id',recutId).eq('status','queued');if(error)throw Error('Cut saved, but re-cut completion failed. Scan again to retry.')}
  let message=result?.already?'✅ Already confirmed cut.':'✅ Part confirmed cut.'
  if(orderId){const status=(await sync(owner,[orderId])).results[0];if(status.retry)message+='\n⚠️ '+status.message+' Scan again to retry.'
   if(status.tagged&&key){
    for(let attempt=0;attempt<5;attempt++){
     const saved=await load();if(saved.workspace.packingAlerts?.[key])break
     if(unresolvedFailedOrderKeys(saved.workspace).has(key)||!cutOrderParts(saved.workspace,key))throw Error('Progress changed before the packing alert. Check the current plan.')
     const claim=crypto.randomUUID();saved.workspace.packingAlerts={...saved.workspace.packingAlerts,[key]:claim}
     if(!await save(saved))continue
     try{await alert(status.name??'#'+orderId)}catch{
      const latest=await load();if(latest.workspace.packingAlerts?.[key]===claim){delete latest.workspace.packingAlerts[key];await save(latest)}
      throw Error('Cut saved and ready to pack, but the group alert failed. Scan again to retry.')
     }
     message+='\n📦 Ready to pack — workshop alerted.';break
    }
   }
  }
  return message
 }
}
