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
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function createTelegram(config:TelegramConfig,store:TelegramStore,send:TelegramSender, extras?: { font: Uint8Array; acknowledge(id: string): Promise<void> }){
 async function reply(chat:string,text:string){for(const chunk of chunks(text))await send(chat,html(chunk))}
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
   const callback=update.callback_query
   const message=callback ? (typeof callback.data==='string' && callback.data.startsWith('tabs:') && callback.message ? {...callback.message,from:callback.from,text:'/tabs '+callback.data.slice(5),web_app_data:undefined} : undefined) : update.message
   if(!message?.from || message.from.is_bot || message.sender_chat)return new Response('OK')
   const chat=String(message.chat?.id)
   if(chat!==config.chatId && !(message.chat?.type==='private' && config.userIds.includes(message.from.id)))return new Response('OK')
   if(callback)await extras?.acknowledge(callback.id).catch(()=>{})
   let text=String(message.text??'')
   if(message.web_app_data && message.chat?.type==='private'){
    try{const data=JSON.parse(message.web_app_data.data);if(data.type!=='part_lookup'||typeof data.id!=='string'||!uuid.test(data.id))throw Error();text='/part '+data.id}catch{await reply(chat,'Invalid scan result. Open /scan and try again.');return new Response('OK')}
   }
   const match=text.trim().match(/^\/(\w+)(?:@([\w]+))?(?:\s+([\s\S]*))?$/)
   if(!match || (match[2] && match[2].toLowerCase()!==config.username.toLowerCase()))return new Response('OK')
   let cmd=match[1].toLowerCase(),arg=match[3]?.trim()??''
   if(cmd==='start' && arg==='scan')cmd='scan'
   if(cmd==='start' && /^part_[a-z0-9-]{1,50}$/i.test(arg)){cmd='part';arg=arg.slice(5)}
   try{
    if(cmd==='tabs'){await tabsReply(chat,arg,store,send,extras?.font);return new Response('OK')}
    if(cmd==='scan'){
     if(message.chat?.type==='private')await send(chat,'📷 <b>Scan a part</b>\n\nTap <b>Scan part QR</b> below to open the camera scanner. Point it at one label.\n\n🔎 Read-only lookup — scanning never marks a part cut.',{reply_markup:{keyboard:[[{text:'📷 Scan part QR',web_app:{url:'https://dpmerron-ltd.github.io/cnc-marketplace/part-scanner.html'}}]],resize_keyboard:true,is_persistent:true}})
     else await send(chat,'📷 <b>Scan a part</b>\n\nOpen the scanner in the bot’s private chat, then tap <b>Scan part QR</b>. Telegram requires the scanner launch button in a private chat.',{reply_markup:{inline_keyboard:[[{text:'📷 Open scanner',url:`https://t.me/${config.username}?start=scan`}]]}})
     return new Response('OK')
    }
    if(['setup','help','start'].includes(cmd)){await send(chat,`🪚 <b>888Group Workshop</b>\n\n📅 /today — day plan &amp; materials\n📦 /orders — saved progress\n🔎 /order 1047 — order details\n📌 /tabs — sheet tab maps\n📷 /scan — camera QR scanner\n🏷 /part ID — labelled part\n\n<i>Read-only: scanning never marks a part cut.</i>\n<a href="${siteUrl}">Open Cutting Jobs ↗</a>`);return new Response('OK')}
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
     await send(chat,`🏷 <b>PART ${instance.partNumber?`P${html(String(instance.partNumber).padStart(3,'0'))}`:''}</b>\n\n<b>${html(await store.component(instance.partId))}</b>\n\n📦 Order: ${html(order)}\n🗂 Job: ${html(job.name)}\n📄 Sheet ${instance.sheetIndex+1}\n${job.sheets[instance.sheetIndex]?.stage==='cut'?'✅':'🟡'} Status: ${(job.sheets[instance.sheetIndex]?.stage??'waiting').toUpperCase()}\n\n<code>${html(instance.id.toUpperCase())}</code>\n\n<i>Read-only lookup — no cutting status changed.</i>`)
    }else{
     if(!/^#?[a-z0-9-]{1,40}$/i.test(arg))throw Error('Use /order followed by the order number, for example /order 1234.')
     const progress=workspace?progressMessage(workspace,arg):'No saved cutting progress.'
     let order:ShopifyOrder|undefined
     try{order=await store.order(arg)}catch{await reply(chat,`${progress}\n\nLive order items are temporarily unavailable. Try again shortly.`);return new Response('OK')}
     if(order){for(const card of orderCards(order,progress))await send(chat,card)}
     else await reply(chat,`${progress}\nNo matching accessible Shopify order found.`)
    }
   }catch(e){try{await reply(chat,e instanceof Error?e.message:'Could not load that information. Please retry.')}catch{return new Response('Delivery failed',{status:503})}}
   return new Response('OK')
  }
 }
}
