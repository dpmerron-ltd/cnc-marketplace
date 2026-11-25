import type { SheetWorkspace } from '../src/jobs/production'
import { orderProgress, today } from '../src/jobs/production'
import { dailyPlanIsCurrent } from '../src/jobs/dailyPlan'
import { dailyMaterialRequirements } from '../src/jobs/dailyMaterials'
import type { ShopifyOrder } from '../src/orders/types'

export interface TelegramConfig { token: string; secret: string; chatId: string; userIds: number[]; ownerId: string; username: string }
export interface TelegramStore {
  workspace(): Promise<SheetWorkspace | undefined>
  order(number: string): Promise<ShopifyOrder | undefined>
  component(id: string): Promise<string>
  exportedPart?(id: string): Promise<string | undefined>
}
export interface TelegramSender { (chatId: string, text: string): Promise<void> }
export const siteUrl = 'https://dpmerron-ltd.github.io/cnc-marketplace/#machine'
const clock = (m:number) => `${String(Math.floor(Math.ceil(m)/60)).padStart(2,'0')}:${String(Math.ceil(m)%60).padStart(2,'0')}`
export function chunks(text:string):string[] {
  const out:string[]=[]
  while(text.length>3500){let at=text.lastIndexOf('\n',3500);if(at<1)at=3500;out.push(text.slice(0,at));text=text.slice(at).replace(/^\n/,'')}
  if(text)out.push(text)
  return out
}
export function planMessages(workspace:SheetWorkspace):string[]{
 const plan=workspace.dailyPlan
 if(!plan || plan.date!==today())return [`No saved cutting plan for today. Create and save one here: ${siteUrl}`]
 const current=dailyPlanIsCurrent(workspace)
 const materials=dailyMaterialRequirements(plan)
 const sections=[`TODAY’S CUTS — ${plan.date}\n09:00–17:00 | 2 machines | ${(plan.cuts.reduce((n,c)=>n+c.seconds,0)/3600).toFixed(1)} / 12 cutting hours\n${current?'Saved cutting plan. Times are estimates.':'This saved plan has changed: re-plan before relying on its times or material totals.'}`,
 'MATERIAL TO PREPARE — 1220 × 1220 mm squares\n'+(materials.materials.map(m=>`${m.material}: ${m.squares} square(s)${m.reviewSheets?` — ${m.reviewSheets} layouts need stock review`:''}`).join('\n')||'No material scheduled.')+`\nTotal confirmed squares: ${materials.totalSquares}`,
 'ORDERS IN THE PLAN\n'+(plan.orders.map(o=>`${o.name}: ${o.scheduled} today | ${o.cut} already cut | ${o.waiting} waiting | ${o.pending} unallocated — ${o.scheduled&&!o.waiting&&!o.pending&&!o.cutting?'all remaining planned today':o.cut&&!o.waiting&&!o.scheduled&&!o.pending&&!o.cutting?'already cut':'partial / needs attention'}`).join('\n')||'No orders scheduled.')]
 for(const machine of [1,2])sections.push(`MACHINE ${machine}\n`+(plan.cuts.filter(c=>c.machine===machine).map(c=>`${clock(c.startMinute)}–${clock(c.endMinute)} | Sheet ${c.sheetIndex+1} | ${c.material} | ${c.orders.join(', ')} | ${c.parts} parts`).join('\n')||'No cuts scheduled.'))
 if(plan.issues.length)sections.push('NEEDS ATTENTION\n'+plan.issues.join('\n'))
 sections.push(`Planned completion is not confirmation of cutting. /orders shows live saved progress; /order 1234 shows an order.\nReview and export cutting files: ${siteUrl}`)
 return sections.flatMap(chunks)
}
export function progressMessage(workspace:SheetWorkspace, number?:string):string {
 const rows=orderProgress(workspace.jobs).filter(o=>!number || o.name.replace(/^#/,'').toLowerCase()===number.replace(/^#/,'').toLowerCase())
 return rows.length ? 'SAVED CUTTING PROGRESS\n'+rows.map(o=>`${o.name}: ${o.cut} cut / ${o.cut+o.waiting+o.cutting+o.pending} components — ${!o.waiting&&!o.cutting&&!o.pending?'ALL PLANNED COMPONENTS CUT':'PARTIAL'}\n${o.waiting} waiting | ${o.cutting} cutting | ${o.pending} unallocated`).join('\n\n') : 'No saved cutting parts found for that order.'
}
export function createTelegram(config:TelegramConfig,store:TelegramStore,send:TelegramSender){
 async function reply(chat:string,text:string){for(const chunk of chunks(text))await send(chat,chunk)}
 return {
  async publish(owner:string,createdAt:string){
   if(owner!==config.ownerId)return {configured:false,sent:false}
   const workspace=await store.workspace()
   if(!workspace?.dailyPlan || workspace.dailyPlan.createdAt!==createdAt || !dailyPlanIsCurrent(workspace))throw Error('The saved plan changed. Re-plan before sharing it.')
   for(const message of planMessages(workspace))await send(config.chatId,message)
   return {configured:true,sent:true}
  },
  async handle(request:Request):Promise<Response>{
   if(request.method!=='POST')return new Response('Method not allowed',{status:405})
   if(!config.secret || request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==config.secret)return new Response('Forbidden',{status:403})
   const reader=request.body?.getReader();if(!reader)return new Response('Invalid body',{status:400})
   let raw='',size=0;const decoder=new TextDecoder()
   while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536){await reader.cancel();return new Response('Too large',{status:413})}raw+=decoder.decode(part.value,{stream:true})}
   let update;try{update=JSON.parse(raw+decoder.decode())}catch{return new Response('Invalid JSON',{status:400})}
   const message=update.message
   if(!message?.from || message.from.is_bot || message.sender_chat)return new Response('OK')
   const chat=String(message.chat?.id)
   if(chat!==config.chatId && !(message.chat?.type==='private' && config.userIds.includes(message.from.id)))return new Response('OK')
   const match=String(message.text??'').trim().match(/^\/(\w+)(?:@([\w]+))?(?:\s+([\s\S]*))?$/)
   if(!match || (match[2] && match[2].toLowerCase()!==config.username.toLowerCase()))return new Response('OK')
   let cmd=match[1].toLowerCase(),arg=match[3]?.trim()??''
   if(cmd==='start' && /^part_[a-z0-9-]{1,50}$/i.test(arg)){cmd='part';arg=arg.slice(5)}
   try{
    if(['setup','help','start'].includes(cmd)){await reply(chat,`888Group CNC bot\n/today — today’s saved plan and materials\n/orders — saved cutting progress\n/order 1234 — order items and cutting progress\n/part ID — identify a labelled part\nScan a part QR with your phone camera to open its details here. Read-only: nothing is marked cut by scanning.\n${siteUrl}`);return new Response('OK')}
    if(!['today','orders','order','part'].includes(cmd)){await reply(chat,'This version is read-only. Use /help for commands.');return new Response('OK')}
    const workspace=await store.workspace()
    if(cmd==='today'){for(const text of workspace?planMessages(workspace):[`No saved workspace yet. ${siteUrl}`])await send(chat,text)}
    else if(cmd==='orders')await reply(chat,workspace?progressMessage(workspace):'No saved cutting jobs yet.')
    else if(cmd==='part'){
     if(!/^[a-z0-9-]{1,50}$/i.test(arg))throw Error('Use /part followed by the full ID below the QR code.')
     const entries=workspace?.jobs.flatMap(job=>job.sheet.instances.filter(i=>i.id.toLowerCase()===arg.toLowerCase()).map(instance=>({job,instance})))??[]
     if(!entries.length){const exported=await store.exportedPart?.(arg.toLowerCase());if(exported){await reply(chat,exported);return new Response('OK')}}
     if(entries.length!==1)throw Error('Part not found uniquely in the current saved workspace. The label may belong to an older or removed job.')
     const {job,instance}=entries[0]
     const order=instance.orderName||job.sheet.orderImports?.find(o=>o.instanceIds.includes(instance.id))?.name||job.sheet.orderNumber||'Unassigned'
     await reply(chat,`PART ${instance.partNumber?`P${String(instance.partNumber).padStart(3,'0')}`:''}\n${await store.component(instance.partId)}\nOrder: ${order}\nJob: ${job.name}\nSheet ${instance.sheetIndex+1}\nStatus: ${(job.sheets[instance.sheetIndex]?.stage??'waiting').toUpperCase()}\nID: ${instance.id.toUpperCase()}\nRead-only lookup — no cutting status changed.`)
    }else{
     if(!/^#?[a-z0-9-]{1,40}$/i.test(arg))throw Error('Use /order followed by the order number, for example /order 1234.')
     const progress=workspace?progressMessage(workspace,arg):'No saved cutting progress.'
     let order:ShopifyOrder|undefined
     try{order=await store.order(arg)}catch{await reply(chat,`${progress}\n\nLive order items are temporarily unavailable. Try again shortly.`);return new Response('OK')}
     await reply(chat,order?`ORDER ${order.name}\nPlaced: ${order.createdAt??'Unknown'}\n${order.cancelledAt?'Cancelled':order.closedAt?'Closed':'Open'}\n\nITEMS\n${order.lineItems.nodes.map(i=>`${i.currentQuantity} × ${i.title}${i.variantTitle?` — ${i.variantTitle}`:''}\nSKU: ${i.sku??'none'} | ${i.unfulfilledQuantity} unfulfilled`).join('\n')}\n\n${progress}\nCutting progress is separate from shipping/fulfilment.`:`${progress}\nNo matching accessible Shopify order found.`)
    }
   }catch(e){try{await reply(chat,e instanceof Error?e.message:'Could not load that information. Please retry.')}catch{return new Response('Delivery failed',{status:503})}}
   return new Response('OK')
  }
 }
}
