import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
const script=readFileSync('public/part-scanner.js','utf8')
const markup=readFileSync('public/part-scanner.html','utf8')
const id='a72ac365-51c7-4aab-a674-2fa1caf874a6'
function setup(platform='ios'){
 document.body.innerHTML=markup.match(/<body>([\s\S]*)<\/body>/)![1]
 const app={platform,ready:vi.fn(),expand:vi.fn(),onEvent:vi.fn((_event:string,_callback:()=>void)=>{}),isVersionAtLeast:vi.fn(()=>true),showScanQrPopup:vi.fn((_p:unknown,_callback:(data:string)=>boolean)=>{}),closeScanQrPopup:vi.fn(),sendData:vi.fn()}
 Object.assign(window,{Telegram:{WebApp:app}})
 new Function('window','document',script)(window,document)
 return app
}
afterEach(()=>{delete (window as unknown as {Telegram?:unknown}).Telegram;document.body.innerHTML=''})
it('opens the native scanner and returns only a valid part identity once',()=>{
 const app=setup();expect(app.showScanQrPopup).toHaveBeenCalledOnce()
 const callback=app.showScanQrPopup.mock.calls[0][1]
 expect(callback('https://example.com/?start=part_'+id)).toBe(false);expect(app.sendData).not.toHaveBeenCalled()
 expect(callback('https://t.me/tripleeightgroup_bot?start=part_'+id)).toBe(true)
 expect(app.closeScanQrPopup).toHaveBeenCalledOnce()
 expect(app.sendData).toHaveBeenCalledWith(JSON.stringify({type:'part_lookup',id}))
 callback(id);expect(app.sendData).toHaveBeenCalledOnce()
})
it('supports manual lookup on desktop without requesting an unsupported camera',()=>{
 const app=setup('tdesktop');expect(app.showScanQrPopup).not.toHaveBeenCalled()
 expect(document.getElementById('status')!.textContent).toContain('iPhone or Android')
 ;(document.getElementById('part-id') as HTMLInputElement).value=id
 document.getElementById('manual')!.dispatchEvent(new Event('submit',{cancelable:true}))
 expect(app.sendData).toHaveBeenCalledWith(JSON.stringify({type:'part_lookup',id}))
})
it('handles cancellation and permission failures without getting stuck',()=>{
 const app=setup();const closed=app.onEvent.mock.calls[0][1] as ()=>void;closed()
 expect(document.getElementById('status')!.textContent).toContain('Scanner closed')
 app.showScanQrPopup.mockImplementationOnce(()=>{throw Error('denied')})
 document.getElementById('scan')!.click()
 expect(document.getElementById('status')!.textContent).toContain('permission')
})
