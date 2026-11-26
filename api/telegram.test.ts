// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createTelegram, chunks, planMessages, type TelegramConfig, type TelegramStore } from './telegram'
import { newWorkspace, today, sheetSignature } from '../src/jobs/production'
import { defaultProgramSettings } from '../src/gcode/programSettings'
const id='a72ac365-51c7-4aab-a674-2fa1caf874a6'
const config:TelegramConfig={token:'secret-token',secret:'webhook-secret',chatId:'-123',userIds:[42],ownerId:'owner',username:'tripleeightgroup_bot'}
function fixture(){
 const workspace=newWorkspace({name:'Job',width:1220,height:1220,spacing:6,borderSpacing:10,gcodeSettings:{...defaultProgramSettings,safeZ:20},instances:[{id,partId:'component',sheetIndex:0,x:10,y:10,rotation:0,locked:false,orderName:'#1234',orderKey:'shop/order',partNumber:1}]})
 const job=workspace.jobs[0]
 workspace.dailyPlan={date:today(),createdAt:new Date().toISOString(),cuts:[{jobId:job.id,sheetIndex:0,sheetWidthMm:1220,sheetHeightMm:1220,signature:sheetSignature(job.sheet,0),orders:['#1234'],material:'12mm Plywood',materialKey:'ply',placedAt:0,seconds:3600,parts:1,machine:1,startMinute:555,endMinute:615}],deferred:[],issues:[],warnings:[],orders:[{name:'#1234',scheduled:1,waiting:0,cutting:0,cut:0,pending:0}]}
 const send=vi.fn(async (_chat:string,_text:string,_options?:{reply_markup?:unknown})=>{}), store:TelegramStore={workspace:vi.fn(async()=>workspace),component:vi.fn(async()=> 'Left panel'),order:vi.fn(async()=>undefined)}
 const bot=createTelegram(config,store,send)
 const call=(text:string,chatId='-123',userId=42,secret='webhook-secret')=>bot.handle(new Request('https://example.com/telegram/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({message:{chat:{id:chatId,type:chatId.startsWith('-')?'group':'private'},from:{id:userId},text}})}))
 return {workspace,bot,send,store,call}
}
describe('read-only workshop Telegram bot',()=>{
 it('requires webhook secret and fixed group / authorised private user',async()=>{const f=fixture();expect((await f.call('/today','-123',42,'wrong')).status).toBe(403);await f.call('/today','-999');await f.call('/today','99',99);expect(f.store.workspace).not.toHaveBeenCalled();expect(f.send).not.toHaveBeenCalled()})
 it('shares saved plan with materials, schedules and planned completion wording',async()=>{const f=fixture();await f.bot.publish('owner',f.workspace.dailyPlan!.createdAt);const text=f.send.mock.calls.flat().join(' ');expect(text).toContain('1220 × 1220');expect(text).toContain('MACHINE 2');expect(text).toContain('all remaining planned today');expect(text).toContain('not confirmation of cutting')})
 it('does not share other accounts, stale previews or old days',async()=>{const f=fixture();expect(await f.bot.publish('other',f.workspace.dailyPlan!.createdAt)).toEqual({configured:false,sent:false});await expect(f.bot.publish('owner','old')).rejects.toThrow('changed');f.workspace.dailyPlan!.date='2000-01-01';expect(planMessages(f.workspace)[0]).toContain('No saved cutting plan');expect(f.send).not.toHaveBeenCalled()})
 it('queries actual saved progress and never mutates it',async()=>{const f=fixture(),before=JSON.stringify(f.workspace);await f.call('/orders@tripleeightgroup_bot');expect(f.send.mock.calls.flat().join(' ')).toMatch(/#1234\s+0\s+1\s+1/);await f.call('/cut '+id);expect(JSON.stringify(f.workspace)).toBe(before);expect(f.send.mock.calls.flat().join(' ')).toContain('scan recording unavailable')})
 it('opens a scanned QR payload in an authorised private chat',async()=>{const f=fixture();await f.call('/start part_'+id,'42');const text=f.send.mock.calls.flat().join(' ');expect(text).toContain('Left panel');expect(text).toContain('Order: #1234');expect(text).toContain('WAITING');expect(text).toContain('no cutting status changed')})
 it('ignores commands for other bots and unknown QR identities',async()=>{const f=fixture();await f.call('/today@another_bot');expect(f.send).not.toHaveBeenCalled();await f.call('/part does-not-exist');expect(f.send.mock.calls.flat().join(' ')).toContain('Part not found')})
 it('shows order progress even when Shopify is unavailable',async()=>{const f=fixture();vi.mocked(f.store.order).mockRejectedValueOnce(Error('private upstream error'));await f.call('/order 1234');const text=f.send.mock.calls.flat().join(' ');expect(text).toContain('#1234');expect(text).toContain('temporarily unavailable');expect(text).not.toContain('private upstream')})
 it('rejects oversized bodies and chunks long messages',async()=>{const f=fixture();const r=await f.bot.handle(new Request('https://example.com',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'webhook-secret'},body:'a'.repeat(70000)}));expect(r.status).toBe(413);expect(chunks('a'.repeat(8000)).every(s=>s.length<=3500)).toBe(true)})
})

it('offers a private keyboard scanner and a group deep-link launcher',async()=>{
 const f=fixture();await f.call('/scan')
 expect(f.send.mock.calls[0][2]).toMatchObject({reply_markup:{inline_keyboard:[[{url:'https://t.me/tripleeightgroup_bot?start=scan'}]]}})
 await f.call('/start scan','42')
 expect(f.send.mock.calls[1][2]).toMatchObject({reply_markup:{keyboard:[[{web_app:{url:'https://dpmerron-ltd.github.io/cnc-marketplace/part-scanner.html?mode=cut'}}]]}})
})
it('treats authenticated Mini App scan results as read-only part lookups',async()=>{
 const f=fixture(),before=JSON.stringify(f.workspace)
 const request=(data:unknown,user=42)=>new Request('https://example.com/telegram/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'webhook-secret'},body:JSON.stringify({message:{chat:{id:String(user),type:'private'},from:{id:user},web_app_data:{data:JSON.stringify(data)}}})})
 await f.bot.handle(request({type:'part_lookup',id}));expect(f.send.mock.calls[0][1]).toContain('Left panel')
 expect(JSON.stringify(f.workspace)).toBe(before)
 f.send.mockClear();await f.bot.handle(request({type:'part_lookup',id},99));expect(f.send).not.toHaveBeenCalled()
 await f.bot.handle(request({type:'mark_cut',id}));expect(f.send.mock.calls[0][1]).toContain('Invalid scan result')
})
it('escapes product markup and keeps table messages self-contained',async()=>{
 const f=fixture();vi.mocked(f.store.component).mockResolvedValue('<b>Malicious & name</b>');await f.call('/part '+id)
 expect(f.send.mock.calls[0][1]).toContain('&lt;b&gt;Malicious &amp; name&lt;/b&gt;')
 f.workspace.dailyPlan!.orders=Array.from({length:80},(_,i)=>({name:'#'+i,scheduled:2,waiting:1,cutting:0,cut:0,pending:0}))
 for(const card of planMessages(f.workspace)){
  expect(card.length).toBeLessThan(4096)
  expect((card.match(/<pre>/g)??[]).length).toBe((card.match(/<\/pre>/g)??[]).length)
 }
})

it('authorises tab buttons using the clicking user and fixed chat before any lookup',async()=>{
 const f=fixture();f.store.tabRuns=vi.fn(async()=>[])
 const callback=(chat:string,user:number,data='tabs:')=>f.bot.handle(new Request('https://example.com',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':config.secret},body:JSON.stringify({callback_query:{id:'callback',data,from:{id:user},message:{from:{is_bot:true,id:1},chat:{id:chat,type:chat.startsWith('-')?'group':'private'}}}})}))
 await callback('99',99);await callback('-999',42);await callback('-123',42,'delete:all')
 expect(f.send).not.toHaveBeenCalled();expect(f.store.tabRuns).not.toHaveBeenCalled()
 await callback('-123',42);expect(f.send.mock.calls[0][1]).toContain('Tab maps are unavailable')
})

it('offers menu buttons and accepts an order number only in reply to its prompt',async()=>{
 const f=fixture();await f.call('/help');expect(f.send.mock.calls[0][2]).toMatchObject({reply_markup:{inline_keyboard:expect.any(Array)}})
 f.send.mockClear()
 await f.bot.handle(new Request('https://example.com',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':config.secret},body:JSON.stringify({callback_query:{id:'c',data:'menu:findorder',from:{id:42},message:{chat:{id:'-123',type:'group'},from:{is_bot:true}}}})}))
 expect(f.send.mock.calls[0][2]).toMatchObject({reply_markup:{force_reply:true}})
 const prompt=f.send.mock.calls[0][1]
 await f.bot.handle(new Request('https://example.com',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':config.secret},body:JSON.stringify({message:{text:'1047',from:{id:42},chat:{id:'-123',type:'group'},reply_to_message:{text:prompt,from:{is_bot:true,username:config.username}}}})}))
 expect(f.store.order).toHaveBeenCalledWith('1047')
})

it('routes packing buttons and separates cut and failure scans with operator authorization',async()=>{
 const f=fixture();f.store.pendingPacking=vi.fn(async()=>({orders:[{id:'gid://shopify/Order/1',name:'#1063',createdAt:'2026-11-26'}],hasNext:true,shop:'shop.myshopify.com'}))
 await f.call('/packing');expect(f.send.mock.calls[0][1]).toContain('Pending packing');expect(f.send.mock.calls[0][2]).toMatchObject({reply_markup:{inline_keyboard:expect.arrayContaining([[{text:'Next ▶',callback_data:'packing:1'}]])}})
 f.store.scanPart=vi.fn(async(_id,_failed,alert)=>{await alert('#1063');return 'Saved'})
 await f.call('/cut '+id,'-123',99);expect(f.store.scanPart).not.toHaveBeenCalled()
 await f.call('/cut '+id);expect(f.store.scanPart).toHaveBeenCalledWith(id,false,expect.any(Function))
 expect(f.send.mock.calls.some(([chat,text])=>chat==='-123'&&text.includes('PACK ORDER #1063'))).toBe(true)
 await f.call('/failedpart '+id);expect(f.store.scanPart).toHaveBeenLastCalledWith(id,true,expect.any(Function))
 await f.call('/failed','42');expect(f.send.mock.calls.at(-1)?.[2]).toMatchObject({reply_markup:{keyboard:[[{web_app:{url:expect.stringContaining('mode=failed')}}]]}})
})
