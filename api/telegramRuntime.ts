import type { SupabaseClient } from '@supabase/supabase-js'
import { createTelegram, type TelegramConfig } from './telegram'
import type { SheetWorkspace } from '../src/jobs/production'
import type { ShopifyReader } from './shopify'
import { orderService } from './orderAssignments'
import type { JobRepository } from './handler'
export function telegramRuntime(db:SupabaseClient,config:TelegramConfig,repo:JobRepository,getShopify:()=>ShopifyReader){
 return createTelegram(config,{
  async workspace(){const {data,error}=await db.from('sheet_projects').select('workspace').eq('owner_id',config.ownerId).eq('id',config.ownerId).maybeSingle();if(error)throw Error('Could not load saved cutting progress. Try again shortly.');return data?.workspace as SheetWorkspace|undefined},
  async component(id){const {data,error}=await db.from('cnc_components').select('name,sku').eq('id',id).maybeSingle();return !error&&data?`${data.name} (${data.sku??''})`:'Component metadata unavailable'},
  async exportedPart(id){
   const {data:runs,error}=await db.from('cnc_machine_runs').select('name,status,snapshot').eq('owner_id',config.ownerId).contains('snapshot',{labels:[{instanceId:id}]}).order('created_at',{ascending:false}).limit(1)
   if(error)throw Error('Could not check saved exports. Try again shortly.')
   const run=runs?.[0],label=run?.snapshot?.labels?.find((l:{instanceId:string})=>l.instanceId===id)
   if(label)return `SAVED EXPORT PART\n${label.component}\nOrder: ${label.order}\nJob: ${run.name}\nSheet ${label.sheetNumber}\nID: ${id.toUpperCase()}\nExport status: ${run.status}. This is an export record, not individual part completion. No status changed.`
   const {data:jobs,error:jobError}=await db.from('cnc_jobs').select('job_name,status,manifest').eq('owner_id',config.ownerId).contains('manifest',{cuts:[{instanceId:id}]}).limit(1)
   if(jobError)throw Error('Could not check saved jobs. Try again shortly.')
   const job=jobs?.[0],cut=job?.manifest?.cuts?.find((c:{instanceId:string})=>c.instanceId===id)
   return cut?`SAVED JOB PART\n${cut.component}\nOrder: ${cut.order}\nJob: ${job.job_name}\nSheet ${cut.sheetNumber}\nID: ${id.toUpperCase()}\nJob status: ${job.status}. This is not individual part completion. No status changed.`:undefined
  },
  async order(number){
   const service=await orderService(repo,getShopify(),config.ownerId)
   const target=number.replace(/^#/,'').toLowerCase()
   let after:string|undefined
   for(let page=0;page<20;page++){
    const params=new URLSearchParams({status:'all',search:number});if(after)params.set('after',after)
    const result=await service.orders(params)
    const found=result.orders.find(o=>o.name.replace(/^#/,'').toLowerCase()===target)
    if(found){
     const id=found.id.split('/').at(-1)!,detail=await service.order(id,new URLSearchParams());const order=detail.order
     const seen=new Set<string>()
     while(order.lineItems.pageInfo.hasNextPage){const cursor=order.lineItems.pageInfo.endCursor;if(!cursor||seen.has(cursor))throw Error('Incomplete order items.');seen.add(cursor);const next=await service.order(id,new URLSearchParams({after:cursor}));order.lineItems.nodes.push(...next.order.lineItems.nodes);order.lineItems.pageInfo=next.order.lineItems.pageInfo;if(seen.size>100)throw Error('Order too large.')}
     return order
    }
    if(!result.pageInfo.hasNextPage)return undefined
    const next=result.pageInfo.endCursor;if(!next||next===after)throw Error('Incomplete order search.');after=next
   }
   throw Error('Too many matching orders. Use the exact order number.')
  }
 },async(chatId,text,options)=>{
  const response=await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text,parse_mode:'HTML',...options,link_preview_options:{is_disabled:true}}),signal:AbortSignal.timeout(15000)})
  const data=await response.json()
  if(!response.ok||!data.ok)throw Error('Telegram could not deliver the message. Retry shortly.')
 })
}
