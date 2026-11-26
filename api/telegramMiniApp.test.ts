// @vitest-environment node
import {it,expect,vi} from 'vitest'
import {createHmac} from 'node:crypto'
import {validateMiniApp,miniAppHandler} from './telegramMiniApp'
import type {TelegramStore} from './telegram'
const token='test-token',now=1800000000000
function signed(user=42,date=now/1000){
 const values=new URLSearchParams({auth_date:String(date),query_id:'session',user:JSON.stringify({id:user,first_name:'Operator'})});values.sort()
 const secret=createHmac('sha256','WebAppData').update(token).digest()
 values.set('hash',createHmac('sha256',secret).update([...values].map(([k,v])=>`${k}=${v}`).join('\n')).digest('hex'));return values.toString()
}
it('validates Telegram signatures, operator identity, expiry and duplicate fields',async()=>{
 expect(await validateMiniApp(signed(),token,[42],now)).toBe(42)
 for(const raw of [signed(99),signed(42,now/1000-43201),signed(42,now/1000+100),signed().replace('Operator','Attacker'),signed()+'&user=x'])await expect(validateMiniApp(raw,token,[42],now)).rejects.toThrow()
 await expect(validateMiniApp(signed(),'other-token',[42],now)).rejects.toThrow()
})
it('saves only authenticated valid scans and returns acknowledgement without closing the Mini App',async()=>{
 const store={scanPart:vi.fn(async()=> '✅ Part confirmed cut.')} as unknown as TelegramStore
 const handler=miniAppHandler({token,secret:'unused',chatId:'-1',userIds:[42],ownerId:'owner',username:'bot'},store,vi.fn())
 const request=(body:unknown,origin='https://dpmerron-ltd.github.io')=>new Request('https://api/telegram/scan',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)})
 const body={initData:signed(42,Math.floor(Date.now()/1000)),id:'12345678-1234-4234-8234-123456789abc',mode:'cut'}
 expect((await handler(request({...body,initData:'forged'}))).status).toBe(403)
 expect((await handler(request(body,'https://evil.test'))).status).toBe(403)
 expect((await handler(request({...body,ownerId:'other'}))).status).toBe(400)
 expect(store.scanPart).not.toHaveBeenCalled()
 const result=await handler(request(body));expect(result.status).toBe(200);expect(await result.json()).toEqual({message:'✅ Part confirmed cut.',warning:false})
 expect(store.scanPart).toHaveBeenCalledWith(body.id,false,expect.any(Function))
 vi.mocked(store.scanPart!).mockRejectedValueOnce(Error('Save failed'))
 const failure=await handler(request({...body,mode:'failed'}));expect(failure.status).toBe(409);expect(await failure.json()).toEqual({error:'Save failed'})
})
