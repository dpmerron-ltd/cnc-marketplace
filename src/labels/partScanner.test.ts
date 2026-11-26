import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
const script=readFileSync('public/part-scanner.js','utf8')
const markup=readFileSync('public/part-scanner.html','utf8')
const id='a72ac365-51c7-4aab-a674-2fa1caf874a6'
function setup(initData='signed-session'){
 document.body.innerHTML=markup.match(/<body>([\s\S]*)<\/body>/)![1]
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({} as CanvasRenderingContext2D)
 const app={initData,ready:vi.fn(),expand:vi.fn(),sendData:vi.fn(),close:vi.fn()}
 Object.assign(window,{Telegram:{WebApp:app}})
 const fetch=vi.fn(async()=>({ok:true,json:async()=>({message:'Found part'})}))
 vi.stubGlobal('fetch',fetch)
 new Function('window','document',script)(window,document)
 const submit=(value:string)=>{(document.getElementById('part-id') as HTMLInputElement).value=value;document.getElementById('manual')!.dispatchEvent(new Event('submit',{cancelable:true}))}
 return {app,fetch,submit}
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();delete (window as unknown as {Telegram?:unknown}).Telegram;document.body.innerHTML=''})
it('ignores foreign QR links and accepts the bot label without sending data or closing',async()=>{
 const f=setup();f.submit('https://example.com/?start=part_'+id);expect(f.fetch).not.toHaveBeenCalled()
 f.submit('https://t.me/tripleeightgroup_bot?start=part_'+id)
 await vi.waitFor(()=>expect(document.getElementById('confirmation-icon')!.textContent).toBe('✓'))
 expect(JSON.parse((f.fetch.mock.calls[0] as any)[1].body)).toEqual({initData:'signed-session',mode:'lookup',id})
 expect(f.app.sendData).not.toHaveBeenCalled();expect(f.app.close).not.toHaveBeenCalled()
})
it('retains manual entry when camera access is unavailable',async()=>{
 const f=setup();expect(document.getElementById('status')!.textContent).toContain('Camera unavailable')
 f.submit(id);await vi.waitFor(()=>expect(document.getElementById('status')!.textContent).toContain('Ready for the next part'))
 expect((document.getElementById('lookup') as HTMLButtonElement).disabled).toBe(false)
})
it('requires a signed launch from the current bot button',()=>{
 const f=setup('');expect(document.getElementById('status')!.textContent).toContain('newest scanner button')
 f.submit(id);expect(f.fetch).not.toHaveBeenCalled()
})
