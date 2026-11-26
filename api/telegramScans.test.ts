// @vitest-environment node
import {it,expect,vi} from 'vitest'
import {recordCut,scanRuntime} from './telegramScans'
import {newWorkspace,sheetSignature,orderProgress} from '../src/jobs/production'
import {defaultProgramSettings} from '../src/gcode/programSettings'
import {cutOrderParts} from './packing'
function fixture(){
 const w=newWorkspace({name:'test',width:1220,height:1220,spacing:6,borderSpacing:10,gcodeSettings:{...defaultProgramSettings,safeZ:20},instances:['a','b'].map(id=>({id,partId:'component',orderKey:'order',sheetIndex:0,x:10,y:10,rotation:0,locked:false}))})
 const j=w.jobs[0];j.sheets[0]={stage:'waiting',runId:'run',signature:sheetSignature(j.sheet,0)};return w
}
it('records one physical part, locks its sheet, and completes only after every part',()=>{
 const w=fixture(),signature=w.jobs[0].sheets[0].signature
 expect(recordCut(w,'a').already).toBe(false)
 expect(w.jobs[0].sheets[0].stage).toBe('cutting')
 expect(orderProgress(w.jobs)[0]).toMatchObject({cut:1,cutting:1})
 expect(cutOrderParts(w,'order')).toBeUndefined()
 expect(recordCut(w,'a').already).toBe(true)
 expect(w.jobs[0].sheets[0].scannedPartIds).toEqual(['a'])
 recordCut(w,'b');expect(w.jobs[0].sheets[0].stage).toBe('cut')
 expect(cutOrderParts(w,'order')?.get('component')).toBe(2)
 expect(sheetSignature(w.jobs[0].sheet,0)).toBe(signature)
})
it('rejects failed, unknown, ambiguous, and stale labels without moving geometry',()=>{
 const w=fixture();w.failedParts={a:'recut'}
 expect(()=>recordCut(w,'a')).toThrow('replacement')
 expect(()=>recordCut(w,'missing')).toThrow('uniquely')
 w.jobs[0].sheet.instances.push({...w.jobs[0].sheet.instances[1]})
 expect(()=>recordCut(w,'b')).toThrow('uniquely')
 const stale=fixture();stale.jobs[0].sheet.instances[0].x++
 expect(()=>recordCut(stale,'a')).toThrow('Export')
})
it('never counts failed originals towards packing quantities',()=>{
 const w=fixture();recordCut(w,'a');recordCut(w,'b');w.failedParts={a:'recut'}
 expect(cutOrderParts(w,'order')?.get('component')).toBe(1)
})

it('persists cut scans, alerts once, queues exact failed part once, and blocks its old label',async()=>{
 let workspace=fixture(),version=1
 const key='test.myshopify.com/gid://shopify/Order/123'
 workspace.jobs[0].sheet.instances.forEach((p,i)=>{p.orderKey=key;p.partNumber=i+1})
 workspace.jobs[0].sheets[0].signature=sheetSignature(workspace.jobs[0].sheet,0)
 const recuts:Array<Record<string,unknown>>=[]
 const db:any={from(table:string){let action='read',payload:any,filters:Record<string,unknown>={}
  const execute=()=>{
   if(table==='sheet_projects'){
    if(action==='update'){if(filters.workspace_version!==version)return {data:[],error:null};workspace=structuredClone(payload.workspace);version=payload.workspace_version;return {data:[{id:'owner'}],error:null}}
    return {data:{workspace:structuredClone(workspace),workspace_version:version},error:null}
   }
   if(table==='cnc_machine_recuts'){
    if(action==='insert'){if(recuts.length)return {data:null,error:{code:'23505'}};recuts.push({...payload,id:'recut',status:'queued'});return {data:recuts[0],error:null}}
    return {data:recuts[0],error:null}
   }
   return {data:table==='marketplace_items'?[{id:'item'}]:[{id:'component'}],error:null}
  }
  const q:any={select:()=>q,limit:()=>q,eq:(k:string,v:unknown)=>{filters[k]=v;return q},match:(v:object)=>{Object.assign(filters,v);return q},update:(v:unknown)=>{action='update';payload=v;return q},insert:(v:unknown)=>{action='insert';payload=v;return q},single:async()=>execute(),maybeSingle:async()=>execute(),then:(resolve:any,reject:any)=>Promise.resolve(execute()).then(resolve,reject)};return q
 }}
 const reader:any={connection:()=>({shop:'test.myshopify.com'}),readyToPack:vi.fn(async()=>{}),removeReadyToPack:vi.fn(async()=>{}),order:async()=>({order:{name:'#1063',lineItems:{nodes:[{sku:'VS-0064',currentQuantity:2}],pageInfo:{hasNextPage:false}}}})}
 const scan=scanRuntime(db,'owner',{orderAdmin:async()=> 'owner'} as any,()=>reader),alert=vi.fn(async()=>{})
 await scan('a',false,alert);expect(alert).not.toHaveBeenCalled()
 await scan('b',false,alert);expect(alert).toHaveBeenCalledExactlyOnceWith('#1063')
 await scan('b',false,alert);expect(alert).toHaveBeenCalledTimes(1)
 await scan('a',true,alert);await scan('a',true,alert)
 expect(recuts).toHaveLength(1);expect(recuts[0]).toMatchObject({source_run_id:'run',part_number:'P001',sheet_index:0})
 expect(workspace.failedParts).toEqual({a:'recut'});expect(workspace.packingAlerts?.[key]).toBeUndefined()
 expect(reader.removeReadyToPack).toHaveBeenCalledWith('owner','123')
 await expect(scan('a',false,alert)).rejects.toThrow('replacement')
 await scan('b',false,alert);expect(alert).toHaveBeenCalledTimes(1)
 const replacement=structuredClone(workspace.jobs[0]);replacement.id='replacement-job';replacement.sheet.instances=[{...replacement.sheet.instances[0],id:'replacement',recutId:'recut'}];replacement.sheets={0:{stage:'waiting',runId:'replacement-run',signature:sheetSignature(replacement.sheet,0)}};workspace.jobs.push(replacement)
 await scan('replacement',false,alert);expect(alert).toHaveBeenCalledTimes(2)
 await scan('replacement',false,alert);expect(alert).toHaveBeenCalledTimes(2)
 await scan('a',true,alert);expect(workspace.packingAlerts?.[key]).toBeTruthy()
})
