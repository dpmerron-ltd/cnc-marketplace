// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { cutOrderParts, coversRequiredParts, packingRuntime } from './packing'
import { newWorkspace, sheetSignature } from '../src/jobs/production'
import { defaultProgramSettings } from '../src/gcode/programSettings'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { JobRepository } from './handler'
import type { ShopifyReader } from './shopify'
const shop='test.myshopify.com',key=shop+'/gid://shopify/Order/123'
function fixture(){
 const w=newWorkspace({name:'Test',width:1220,height:1220,spacing:10,borderSpacing:10,gcodeSettings:{...defaultProgramSettings,safeZ:20},instances:['a','b'].map((partId,i)=>({id:'instance'+i,partId,orderKey:key,sheetIndex:i,x:20,y:20,rotation:0,locked:false}))})
 for(const index of [0,1])w.jobs[0].sheets[index]={stage:'cut',runId:'export',signature:sheetSignature(w.jobs[0].sheet,index)}
 const readyToPack=vi.fn(async()=>{}),reader={connection:()=>({connected:true,shop}),order:vi.fn(async()=>({order:{id:'gid://shopify/Order/123',name:'#123',lineItems:{nodes:[{id:'line',sku:'RACK',currentQuantity:1}],pageInfo:{hasNextPage:false}}}})),readyToPack} as unknown as ShopifyReader
 const query=(data:unknown)=>{const q:any={data,error:null};for(const method of ['select','eq','limit'])q[method]=()=>q;q.maybeSingle=async()=>q;return q}
 const db={from:vi.fn((table:string)=>query(table==='sheet_projects'?{workspace:w,workspace_version:1}:table==='marketplace_items'?[{id:'rack'}]:[{id:'a'},{id:'b'}]))} as unknown as SupabaseClient
 const sync=packingRuntime(db,{orderAdmin:async()=> 'owner'} as JobRepository,()=>reader)
 return {w,readyToPack,reader,db,sync}
}
it('requires complete saved cut confirmations and exact component coverage',()=>{
 const f=fixture();expect(coversRequiredParts(cutOrderParts(f.w,key)!,new Map([['a',1],['b',1]]))).toBe(true)
 expect(coversRequiredParts(cutOrderParts(f.w,key)!,new Map([['a',2],['b',1]]))).toBe(false)
 f.w.jobs[0].sheets[1].stage='waiting';expect(cutOrderParts(f.w,key)).toBeUndefined()
 f.w.jobs[0].sheets[1].stage='cut';f.w.jobs[0].sheet.instances[1].x++
 expect(cutOrderParts(f.w,key)).toBeUndefined()
})
it('adds only the packing tag for a verified complete order, with repeat-safe writer',async()=>{
 const f=fixture();expect((await f.sync('owner',['123'])).results[0]).toMatchObject({tagged:true,name:'#123'})
 expect(f.readyToPack).toHaveBeenCalledWith('owner','123')
})
it('rejects another account and avoids Shopify writes for partial or missing BOM parts',async()=>{
 const f=fixture();await expect(f.sync('other',['123'])).rejects.toThrow('administrator');expect(f.db.from).not.toHaveBeenCalled()
 f.w.jobs[0].sheets[1].stage='waiting';await f.sync('owner',['123']);expect(f.reader.order).not.toHaveBeenCalled()
 f.w.jobs[0].sheet.instances.pop();await f.sync('owner',['123']);expect(f.readyToPack).not.toHaveBeenCalled()
})
it('reports retriable write failure without changing saved cutting progress',async()=>{
 const f=fixture(),before=JSON.stringify(f.w);f.readyToPack.mockRejectedValueOnce(Error('Missing write_orders'))
 const r=await f.sync('owner',['123']);expect(r.results[0]).toMatchObject({tagged:false,retry:true,message:'Missing write_orders'});expect(JSON.stringify(f.w)).toBe(before)
})
it('rejects duplicate identities and outstanding pending components',()=>{
 const f=fixture();f.w.jobs[0].sheet.pendingParts=[{...f.w.jobs[0].sheet.instances[0],id:'pending'}];expect(cutOrderParts(f.w,key)).toBeUndefined()
 f.w.jobs[0].sheet.pendingParts=[];f.w.jobs.push(structuredClone(f.w.jobs[0]));expect(cutOrderParts(f.w,key)).toBeUndefined()
})
