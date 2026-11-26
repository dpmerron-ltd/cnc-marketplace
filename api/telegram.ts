import { miniAppHandler } from './telegramMiniApp'
import type { TabRun, TabRunSummary } from './telegramTabs'
import { tabsReply } from './telegramTabs'
import type { SheetWorkspace } from '../src/jobs/production'
import { dailyPlanIsCurrent } from '../src/jobs/dailyPlan'
import type { ShopifyOrder } from '../src/orders/types'
import { html, planMessages, progressMessage, progressCards, orderCards, siteUrl } from './telegramFormat'
export { planMessages, progressMessage } from './telegramFormat'
export interface TelegramConfig { token: string; secret: string; chatId: string; userIds: number[]; ownerId: string; username: string }
export interface TelegramStore {
  tabRuns?(offset: number): Promise<TabRunSummary[]>
  tabRun?(id: string): Promise<TabRun | undefined>
  pendingPacking?(page:number):Promise<{orders:Array<{id:string;name:string;createdAt:string}>;hasNext:boolean;shop:string}>
  scanPart?(id:string,failed:boolean,alert:(name:string)=>Promise<void>):Promise<string>
  workspace(): Promise<SheetWorkspace | undefined>
  order(number: string): Promise<ShopifyOrder | undefined>
  component(id: string): Promise<string>
  exportedPart?(id: string): Promise<string | undefined>
}
export interface TelegramSender { (chatId: string, text: string, options?: { reply_markup?: unknown; document?: { bytes: Uint8Array; filename: string } }): Promise<void> }
export function chunks(text:string):string[] {
  const out:string[]=[]
  while(text.length>3500){let at=text.lastIndexOf('\n',3500);if(at<1)at=3500;out.push(text.slice(0,at));text=text.slice(at).replace(/^\n/,'')}
  if(text)out.push(text)
  return out
}
export const workshopMenu = {inline_keyboard:[[{text:'📅 Today’s cuts',callback_data:'menu:today'},{text:'📦 Orders',callback_data:'menu:orders'}],[{text:'🔎 Find order',callback_data:'menu:findorder'},{text:'📌 Tab maps',callback_data:'tabs:'}],[{text:'📦 Pending packing',callback_data:'packing:0'}],[{text:'✅ Scan cut part',callback_data:'menu:scan'},{text:'🔁 Scan failed part',callback_data:'menu:failed'}]]}
const orderPrompt = '🔎 Which order? Reply to this message with the order number, for example 1047.'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function createTelegram(config:TelegramConfig,store:TelegramStore,send:TelegramSender, extras?: { font: Uint8Array; acknowledge(id: string): Promise<void> }){
 async function reply(chat:string,text:string){for(const chunk of chunks(text))await send(chat,html(chunk))}
 return {
  scan:miniAppHandler(config,store,async name=>{await send(config.chatId,`📦 <b>PACK ORDER ${html(name)}</b>\n\n✅ All required parts confirmed cut.\n🏷 Ready to pack`,{reply_markup:workshopMenu})}),
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
   const callback=update.callback_query
   const message=callback ? (typeof callback.data==='string' && /^(tabs:|packing:\d{1,2}$|menu:(today|orders|findorder|scan|failed|help)$)/.test(callback.data) && callback.message ? {...callback.message,from:callback.from,text:callback.data.startsWith('tabs:')?'/tabs '+callback.data.slice(5):callback.data.startsWith('packing:')?'/packing '+callback.data.slice(8):'/'+callback.data.slice(5),web_app_data:undefined} : undefined) : update.message
   if(!message?.from || message.from.is_bot || message.sender_chat)return new Response('OK')
   const chat=String(message.chat?.id)
   if(chat!==config.chatId && !(message.chat?.type==='private' && config.userIds.includes(message.from.id)))return new Response('OK')
   if(callback)await extras?.acknowledge(callback.id).catch(()=>{})
   let text=String(message.text??'')
   if(!callback && message.reply_to_message?.from?.is_bot && message.reply_to_message.from.username?.toLowerCase()===config.username.toLowerCase() && message.reply_to_message.text===orderPrompt) text='/order '+text.trim()
   if(message.web_app_data && message.chat?.type==='private'){
    try{const data=JSON.parse(message.web_app_data.data);if(!['part_lookup','part_cut','part_failed'].includes(data.type)||typeof data.id!=='string'||!uuid.test(data.id))throw Error();text=(data.type==='part_cut'?'/cut ':data.type==='part_failed'?'/failedpart ':'/part ')+data.id}catch{await reply(chat,'Invalid scan result. Open /scan and try again.');return new Response('OK')}
   }
   const match=text.trim().match(/^\/(\w+)(?:@([\w]+))?(?:\s+([\s\S]*))?$/)
   if(!match || (match[2] && match[2].toLowerCase()!==config.username.toLowerCase()))return new Response('OK')
   let cmd=match[1].toLowerCase(),arg=match[3]?.trim()??''
   if(cmd==='start' && ['scan','failed'].includes(arg))cmd=arg
   if(cmd==='start' && /^part_[a-z0-9-]{1,50}$/i.test(arg)){cmd='part';arg=arg.slice(5)}
   try{
    if(cmd==='cut'||cmd==='failedpart'){
     if(!config.userIds.includes(message.from.id))throw Error('Only authorised workshop operators can record scans.')
     if(!uuid.test(arg)||!store.scanPart)throw Error('Invalid scan or scan recording unavailable.')
     await send(chat,await store.scanPart(arg.toLowerCase(),cmd==='failedpart',async name=>{await send(config.chatId,`📦 <b>PACK ORDER ${html(name)}</b>\n\n✅ All required parts confirmed cut.\n🏷 Ready to pack`,{reply_markup:workshopMenu})}))
     await send(chat,'🪚 <b>Workshop menu</b>',{reply_markup:workshopMenu});return new Response('OK')
    }
    if(cmd==='packing'){
     if(!store.pendingPacking||!/^\d{1,2}$/.test(arg||'0'))throw Error('Pending packing unavailable. Try again shortly.')
     const page=Number(arg||0),result=await store.pendingPacking(page)
     const lines=result.orders.map(o=>`📦 <a href="https://${html(result.shop)}/admin/orders/${o.id.split('/').at(-1)}">${html(o.name)}</a> · ${html(o.createdAt.slice(0,10))}`)
     await send(chat,`📦 <b>Pending packing</b> · Page ${page+1}\n\n${lines.join('\n')||'✅ No orders awaiting packing on this page.'}\n\n<i>Live Shopify orders tagged Ready to pack, oldest first. Fulfilled and closed orders are excluded.</i>`,{reply_markup:{inline_keyboard:[...(page>0?[[{text:'◀ Previous',callback_data:`packing:${page-1}`}]]:[]),...(result.hasNext&&page<99?[[{text:'Next ▶',callback_data:`packing:${page+1}`}]]:[]),[{text:'🔄 Refresh',callback_data:`packing:${page}`}],[{text:'🪚 Workshop menu',callback_data:'menu:help'}]]}})
     return new Response('OK')
    }
    if(cmd==='findorder'){await send(chat,orderPrompt,{reply_markup:{force_reply:true,selective:true,input_field_placeholder:'Order number, e.g. 1047'}});return new Response('OK')}
    if(cmd==='tabs'){await tabsReply(chat,arg,store,send,extras?.font);return new Response('OK')}
    if(cmd==='scan'||cmd==='failed'){
     const failed=cmd==='failed'
     if(message.chat?.type==='private')await send(chat,failed?'🔁 <b>Scan failed part</b>\n\nScanning queues this exact part for re-cut and removes its order from packing readiness.':'✅ <b>Scan cut part</b>\n\nScanning confirms each part is cut. A green tick confirms it saved; keep scanning. The final part triggers a PACK ORDER alert.',{reply_markup:{inline_keyboard:[[{text:failed?'🔁 Scan failed QR':'✅ Scan cut QR',web_app:{url:'https://dpmerron-ltd.github.io/cnc-marketplace/part-scanner.html?mode='+(failed?'failed':'cut')}}]]}})
     else await send(chat,'📷 <b>Scan a part</b>\n\nOpen the scanner in the bot’s private chat, then tap <b>Scan part QR</b>. Telegram requires the scanner launch button in a private chat.',{reply_markup:{inline_keyboard:[[{text:'📷 Open scanner',url:`https://t.me/${config.username}?start=${failed?'failed':'scan'}`}]]}})
     return new Response('OK')
    }
    if(['setup','help','start'].includes(cmd)){await send(chat,`🪚 <b>888Group Workshop</b>\n\n📅 /today — day plan &amp; materials\n📦 /orders — saved progress\n🔎 /order 1047 — order details\n📌 /tabs — sheet tab maps\n✅ /scan — confirm cut part\n🔁 /failed — queue failed part\n📦 /packing — pending packing\n🏷 /part ID — labelled part\n\n<i>Use the buttons below. Cut and failed scans update production progress.</i>\n<a href="${siteUrl}">Open Cutting Jobs ↗</a>`,{reply_markup:workshopMenu});return new Response('OK')}
    if(!['today','orders','order','part'].includes(cmd)){await reply(chat,'This version is read-only. Use /help for commands.');return new Response('OK')}
    const workspace=await store.workspace()
    if(cmd==='today'){for(const text of workspace?planMessages(workspace):[`No saved workspace yet. ${siteUrl}`])await send(chat,text)}
    else if(cmd==='orders'){for(const card of workspace?progressCards(workspace):['📦 No saved cutting jobs yet.'])await send(chat,card)}
    else if(cmd==='part'){
     if(!/^[a-z0-9-]{1,50}$/i.test(arg))throw Error('Use /part followed by the full ID below the QR code.')
     const entries=workspace?.jobs.flatMap(job=>job.sheet.instances.filter(i=>i.id.toLowerCase()===arg.toLowerCase()).map(instance=>({job,instance})))??[]
     if(!entries.length){const exported=await store.exportedPart?.(arg.toLowerCase());if(exported){await send(chat,'🏷 <b>Saved part</b>\n\n'+html(exported));return new Response('OK')}}
     if(entries.length!==1)throw Error('Part not found uniquely in the current saved workspace. The label may belong to an older or removed job.')
     const {job,instance}=entries[0]
     const order=instance.orderName||job.sheet.orderImports?.find(o=>o.instanceIds.includes(instance.id))?.name||job.sheet.orderNumber||'Unassigned'
     await send(chat,`🏷 <b>PART ${instance.partNumber?`P${html(String(instance.partNumber).padStart(3,'0'))}`:''}</b>\n\n<b>${html(await store.component(instance.partId))}</b>\n\n📦 Order: ${html(order)}\n🗂 Job: ${html(job.name)}\n📄 Sheet ${instance.sheetIndex+1}\n${job.sheets[instance.sheetIndex]?.stage==='cut'||job.sheets[instance.sheetIndex]?.scannedPartIds?.includes(instance.id)?'✅':'🟡'} Status: ${(workspace?.failedParts?.[instance.id]?'failed':job.sheets[instance.sheetIndex]?.scannedPartIds?.includes(instance.id)?'cut':job.sheets[instance.sheetIndex]?.stage??'waiting').toUpperCase()}\n\n<code>${html(instance.id.toUpperCase())}</code>\n\n<i>Read-only lookup — no cutting status changed.</i>`)
    }else{
     if(!/^#?[a-z0-9-]{1,40}$/i.test(arg))throw Error('Use /order followed by the order number, for example /order 1234.')
     const progress=workspace?progressMessage(workspace,arg):'No saved cutting progress.'
     let order:ShopifyOrder|undefined
     try{order=await store.order(arg)}catch{await reply(chat,`${progress}\n\nLive order items are temporarily unavailable. Try again shortly.`);return new Response('OK')}
     if(order){for(const card of orderCards(order,progress))await send(chat,card)}
     else await reply(chat,`${progress}\nNo matching accessible Shopify order found.`)
    }
    await send(chat,'🪚 <b>Workshop menu</b>',{reply_markup:workshopMenu})
   }catch(e){try{await reply(chat,e instanceof Error?e.message:'Could not load that information. Please retry.')}catch{return new Response('Delivery failed',{status:503})}}
   return new Response('OK')
  }
 }
}
