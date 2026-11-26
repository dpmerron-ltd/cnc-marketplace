// @vitest-environment node
import {it,expect,vi} from 'vitest'
import vm from 'node:vm'
import fs from 'node:fs'
function fixture(mode='cut'){
 const elements=new Map<string,any>(),events=new Map<string,Function>(),frames:Function[]=[]
 const get=(id:string)=>{if(!elements.has(id))elements.set(id,{value:'12345678-1234-4234-8234-123456789abc',dataset:{},hidden:true,textContent:'',readyState:2,videoWidth:600,videoHeight:600,addEventListener:(event:string,callback:Function)=>events.set(id+event,callback),getContext:()=>({drawImage(){},getImageData:()=>({data:[]})}),play:async()=>{}});return elements.get(id)}
 const fetch=vi.fn(async()=>({ok:true,json:async()=>({message:'✅ Part confirmed cut.'})})),sendData=vi.fn(),close=vi.fn(),stop=vi.fn()
 const app={initData:'signed-init-data',ready(){},expand(){},sendData,close,HapticFeedback:{notificationOccurred:vi.fn()}}
 const clock={now:10000}
 const context={window:{Telegram:{WebApp:app},jsQR:()=>null,addEventListener(){}},document:{getElementById:get,querySelector:get,body:{dataset:{}},addEventListener(){}},navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop}]})}},location:{search:'?mode='+mode},fetch,URL,URLSearchParams,AbortSignal,setTimeout:()=>1,clearTimeout(){},Date:{now:()=>clock.now},requestAnimationFrame:(f:Function)=>frames.push(f)}
 vm.runInNewContext(fs.readFileSync('public/part-scanner.js','utf8'),context)
 const submit=()=>events.get('manualsubmit')!({preventDefault(){}})
 return {get,fetch,sendData,close,submit,context,frames,stop,clock}
}
const settle=()=>new Promise(resolve=>setImmediate(resolve))
it('keeps the camera open, confirms only after saving, and accepts the next ID without reopening',async()=>{
 const f=fixture();await settle()
 let release:Function=()=>{};f.fetch.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}) as any)
 f.submit();expect(f.get('confirmation').hidden).toBe(true);expect(f.get('loading').hidden).toBe(false)
 release({ok:true,json:async()=>({message:'Saved'})});await settle()
 expect(f.get('confirmation').dataset.kind).toBe('success');expect(f.get('confirmation-icon').textContent).toBe('✓')
 expect(f.stop).not.toHaveBeenCalled();expect(f.sendData).not.toHaveBeenCalled();expect(f.close).not.toHaveBeenCalled()
 f.get('part-id').value='22345678-1234-4234-8234-123456789abc';f.submit();await settle();expect(f.fetch).toHaveBeenCalledTimes(2)
})
it('never shows a success tick on save failure and sends the selected failed-part mode',async()=>{
 const f=fixture('failed');await settle();f.fetch.mockResolvedValueOnce({ok:false,json:async()=>({error:'Save failed'})} as any)
 f.submit();await settle();expect(f.get('confirmation').dataset.kind).toBe('error')
 expect(JSON.parse((f.fetch.mock.calls[0] as any)[1].body).mode).toBe('failed')
 expect(f.stop).not.toHaveBeenCalled();expect(f.get('lookup').disabled).toBe(false)
})

it('automatically scans the next QR while suppressing a held label',async()=>{
 const f=fixture();await settle()
 let id='12345678-1234-4234-8234-123456789abc'
 f.context.window.jsQR=(()=>({data:id})) as any
 f.frames.shift()!(1000);await settle();expect(f.fetch).toHaveBeenCalledTimes(1)
 f.clock.now+=2000;f.frames.shift()!(2000);await settle();expect(f.fetch).toHaveBeenCalledTimes(1)
 id='22345678-1234-4234-8234-123456789abc'
 f.frames.shift()!(3000);await settle();expect(f.fetch).toHaveBeenCalledTimes(2)
 expect(f.get('confirmation').dataset.kind).toBe('success');expect(f.stop).not.toHaveBeenCalled()
})
