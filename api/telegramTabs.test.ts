// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { tabsReply, type TabRun } from './telegramTabs'
import type { TelegramStore, TelegramSender } from './telegram'
const id='11111111-1111-4111-8111-111111111111'
const font=await readFile(new URL('./assets/NotoSans-Regular.ttf',import.meta.url))
function fixture(){
 const run={id,name:'Rack <12mm>',created_at:'2026-11-25T10:00:00Z',status:'waiting',snapshot:{version:1,map:{name:'Rack',order:'#1047',width:1220,height:1220,sheetCount:3,parts:[0,2].map(sheetIndex=>({number:`P00${sheetIndex+1}`,name:'Side',sheetIndex,rotation:90,bounds:{minX:10,minY:20,maxX:200,maxY:400},paths:[[{x:10,y:20},{x:200,y:400}]],tabs:[{points:[{x:10,y:20},{x:20,y:20}],center:{x:15,y:20},z:-10,operation:'Outer',inferred:false}],warnings:[]}))}}} as TabRun
 const store:TelegramStore={workspace:vi.fn(),component:vi.fn(),order:vi.fn(),tabRuns:vi.fn(async()=>[run]),tabRun:vi.fn(async()=>run)}
 const send=vi.fn<TelegramSender>()
 return {run,store,send}
}
it('lists exports then only occupied physical sheets with stable export IDs',async()=>{
 const f=fixture();await tabsReply('42','',f.store,f.send,font)
 expect(f.send.mock.calls[0][2]).toMatchObject({reply_markup:{inline_keyboard:expect.arrayContaining([[{text:expect.any(String),callback_data:`tabs:${id}`}]])}})
 await tabsReply('42',id,f.store,f.send,font)
 expect(f.send.mock.calls[1][1]).toContain('Rack &lt;12mm&gt;')
 expect(f.send.mock.calls[1][2]).toMatchObject({reply_markup:{inline_keyboard:[[{callback_data:`tabs:${id} 1`}],[{callback_data:`tabs:${id} 3`}]]}})
})
it('renders only selected sheet and part details without mutating saved snapshot',async()=>{
 const f=fixture(),before=JSON.stringify(f.run);await tabsReply('42',id+' 3',f.store,f.send,font)
 const doc=f.send.mock.calls[1][2]?.document
 expect(doc?.filename).toContain('sheet-3.pdf')
 expect((await PDFDocument.load(doc!.bytes)).getPageCount()).toBe(2)
 expect(f.send.mock.calls[1][1]).toContain('1 identified tab locations')
 expect(f.send.mock.calls[1][1]).toContain('#machine/'+id+'?sheet=3')
 expect(f.send.mock.calls[1][1]).not.toContain('#machine#machine')
 expect(JSON.stringify(f.run)).toBe(before)
})
it('rejects missing exports, invalid arguments and unoccupied sheets',async()=>{
 const f=fixture()
 for(const arg of [id+' 2',id+' 0',id+' -1',id+' 1 extra','bad-id'])await expect(tabsReply('42',arg,f.store,f.send,font)).rejects.toThrow()
 vi.mocked(f.store.tabRun!).mockResolvedValue(undefined)
 await expect(tabsReply('42',id,f.store,f.send,font)).rejects.toThrow('no available tab map')
 expect(f.send).not.toHaveBeenCalled()
})
