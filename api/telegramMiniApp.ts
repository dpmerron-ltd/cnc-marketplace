import { z } from 'zod'
import type { TelegramConfig, TelegramStore } from './telegram'
const origin='https://dpmerron-ltd.github.io'
const bodySchema=z.strictObject({initData:z.string().min(1).max(12000),id:z.uuid(),mode:z.enum(['cut','failed','lookup'])})
const encode=(s:string)=>new TextEncoder().encode(s)
export async function validateMiniApp(raw:string,token:string,users:number[],now=Date.now()):Promise<number>{
 const values=new URLSearchParams(raw)
 if([...values.keys()].length!==new Set(values.keys()).size)throw Error('Invalid scanner session. Reopen the scanner from the bot.')
 const hash=values.get('hash')??'',date=Number(values.get('auth_date'))
 if(!/^[a-f0-9]{64}$/i.test(hash)||!Number.isSafeInteger(date)||date>now/1000+30||date<now/1000-12*3600)throw Error('Scanner session expired. Reopen the scanner from the bot.')
 values.delete('hash');values.sort()
 const key=await crypto.subtle.importKey('raw',encode('WebAppData'),{name:'HMAC',hash:'SHA-256'},false,['sign'])
 const secret=await crypto.subtle.sign('HMAC',key,encode(token))
 const verification=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['verify'])
 const signature=Uint8Array.from(hash.match(/../g)!,h=>parseInt(h,16))
 if(!await crypto.subtle.verify('HMAC',verification,signature,encode([...values].map(([k,v])=>`${k}=${v}`).join('\n'))))throw Error('Invalid scanner session. Reopen the scanner from the bot.')
 const user=JSON.parse(values.get('user')??'null')
 if(!Number.isSafeInteger(user?.id)||!users.includes(user.id)||user.is_bot)throw Error('Only authorised workshop operators can scan parts.')
 return user.id
}
export function miniAppHandler(config:TelegramConfig,store:TelegramStore,alert:(name:string)=>Promise<void>){
 return async(request:Request)=>{
  const headers={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Cache-Control':'no-store','Vary':'Origin'}
  const json=(value:unknown,status=200)=>Response.json(value,{status,headers})
  if(request.headers.get('Origin')!==origin)return json({error:'Origin not allowed.'},403)
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers})
  if(request.method!=='POST')return json({error:'Method not allowed.'},405)
  if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'Expected JSON.'},400)
  let raw='',size=0
  const stream=request.body?.getReader();if(!stream)return json({error:'Missing scan.'},400)
  const decoder=new TextDecoder()
  while(true){const chunk=await stream.read();if(chunk.done)break;size+=chunk.value.length;if(size>16384){await stream.cancel();return json({error:'Scan too large.'},413)}raw+=decoder.decode(chunk.value,{stream:true})}
  let body:z.infer<typeof bodySchema>
  try{body=bodySchema.parse(JSON.parse(raw+decoder.decode()))}catch{return json({error:'Invalid scan.'},400)}
  try{await validateMiniApp(body.initData,config.token,config.userIds)}catch(e){return json({error:e instanceof Error?e.message:'Invalid scanner session.'},403)}
  try{
   if(body.mode==='lookup'){
    const w=await store.workspace(),parts=w?.jobs.flatMap(job=>job.sheet.instances.filter(p=>p.id===body.id).map(part=>({job,part})))??[]
    if(parts.length!==1)throw Error('Part not found uniquely in the current saved plan.')
    const {job,part}=parts[0]
    return json({message:`${await store.component(part.partId)}\nOrder ${part.orderName??job.sheet.orderNumber??'unassigned'} · Sheet ${part.sheetIndex+1}`,warning:false})
   }
   if(!store.scanPart)throw Error('Scan recording is unavailable. Please retry.')
   const message=await store.scanPart(body.id.toLowerCase(),body.mode==='failed',alert)
   return json({message,warning:message.includes('⚠️')})
  }catch(e){return json({error:e instanceof Error?e.message:'Could not save scan. Retry this part.'},409)}
 }
}
