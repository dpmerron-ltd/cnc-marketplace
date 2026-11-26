(() => {
  const app = window.Telegram?.WebApp
  const get = id => document.getElementById(id)
  const video=get('camera'),canvas=get('frame'),status=get('status'),loading=get('loading'),confirmation=get('confirmation'),scan=get('scan'),lookup=get('lookup')
  const context=canvas.getContext('2d',{willReadFrequently:true})
  const requested=new URLSearchParams(location.search).get('mode')
  const mode=['cut','failed'].includes(requested)?requested:'lookup'
  const endpoint='https://bsnndtwbvgrthddmbhoa.supabase.co/functions/v1/cnc-api/telegram/scan'
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  let busy=false,stream,starting=false,lastId='',lastSeen=0,cooldown=0,lastFrame=0,confirmed=0,overlayTimer
  document.querySelector('h1').textContent=mode==='failed'?'Scan failed parts':mode==='cut'?'Scan cut parts':'Look up parts'
  get('mode-description').textContent=mode==='failed'?'🔁 FAILED MODE · Each scan queues that part for re-cut.':mode==='cut'?'✅ CUT MODE · Each scan confirms that part is cut.':'🔎 LOOKUP MODE · No cutting status changes.'
  document.body.dataset.mode=mode
  function partId(raw){
    const text=String(raw).trim()
    if(uuid.test(text))return text.toLowerCase()
    if(/^CNC:PART:/i.test(text)&&uuid.test(text.slice(9)))return text.slice(9).toLowerCase()
    try{const url=new URL(text);if(url.protocol==='https:'&&url.hostname==='t.me'&&url.pathname==='/tripleeightgroup_bot'){const value=url.searchParams.get('start');if(value?.startsWith('part_')&&uuid.test(value.slice(5)))return value.slice(5).toLowerCase()}}catch{ /* Ignore unrelated QR payloads. */ }
  }
  function feedback(kind,text){
    clearTimeout(overlayTimer)
    confirmation.dataset.kind=kind;confirmation.hidden=false
    get('confirmation-icon').textContent=kind==='success'?'✓':kind==='warning'?'!':'✕'
    get('confirmation-text').textContent=kind==='success'?(mode==='failed'?'Re-cut recorded':mode==='cut'?'Cut confirmed':'Part found'):kind==='warning'?'Saved — needs attention':'Not confirmed'
    status.textContent=text
    app?.HapticFeedback?.notificationOccurred(kind==='success'?'success':kind==='warning'?'warning':'error')
    overlayTimer=setTimeout(()=>{confirmation.hidden=true},kind==='error'?2500:1100)
  }
  async function submit(raw){
    if(busy)return
    const id=partId(raw)
    if(!id){feedback('error','Not a CNC part QR or full ID. Try its part label.');return}
    if(!app?.initData){feedback('error','Reopen the scanner using the newest Scan cut part or Scan failed part button in the bot.');return}
    busy=true;lookup.disabled=true;loading.hidden=false;lastId=id;status.textContent='Saving scan…'
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:app.initData,id,mode}),signal:AbortSignal.timeout(90000)})
      const result=await response.json()
      if(!response.ok||typeof result.message!=='string')throw Error(result.error||'Could not confirm the scan. Move this label away and back to retry.')
      confirmed++;get('count').textContent=`${confirmed} scan${confirmed===1?'':'s'} confirmed this session`
      feedback(result.warning?'warning':'success',result.message+'\nReady for the next part.')
      get('part-id').value=''
    }catch(error){feedback('error',error instanceof Error&&error.name!=='TimeoutError'?error.message:'No confirmation received. Move this label away and back to retry. Repeat scans are safe.')}
    finally{busy=false;lookup.disabled=false;loading.hidden=true;cooldown=Date.now()+1200}
  }
  function frame(timestamp){
    if(!stream)return
    if(timestamp-lastFrame>=150&&!document.hidden&&video.readyState>=2){
      lastFrame=timestamp
      const width=Math.min(720,video.videoWidth),height=Math.round(video.videoHeight*width/video.videoWidth)
      if(width&&height&&context){
        canvas.width=width;canvas.height=height;context.drawImage(video,0,0,width,height)
        const pixels=context.getImageData(0,0,width,height)
        const code=window.jsQR(pixels.data,width,height,{inversionAttempts:'attemptBoth'})
        const id=code&&partId(code.data),now=Date.now()
        if(id){lastSeen=now;if(!busy&&now>=cooldown&&id!==lastId)void submit(id)}
        else if(!busy&&now-lastSeen>800)lastId=''
      }
    }
    requestAnimationFrame(frame)
  }
  async function start(){
    if(starting||stream)return
    if(!app?.initData){status.textContent='Use the newest scanner button in the bot’s private chat to start a secure scanning session.';scan.disabled=true;lookup.disabled=true;return}
    if(!navigator.mediaDevices?.getUserMedia||!context||!window.jsQR){status.textContent='Camera unavailable on this device. Enter the part ID below.';return}
    starting=true;scan.disabled=true;status.textContent='Opening camera…'
    try{
      stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280}},audio:false})
      video.srcObject=stream;await video.play();scan.hidden=true;get('camera-box').hidden=false
      status.textContent='Point at a part QR. Wait for the tick, then move to the next part.'
      requestAnimationFrame(frame)
    }catch{stop();status.textContent='Allow camera access, then tap Start camera. You can also enter a part ID below.'}
    finally{starting=false;scan.disabled=false}
  }
  function stop(){stream?.getTracks().forEach(track=>track.stop());stream=undefined;video.srcObject=null;scan.hidden=false}
  scan.addEventListener('click',start)
  get('manual').addEventListener('submit',event=>{event.preventDefault();void submit(get('part-id').value)})
  window.addEventListener('pagehide',stop)
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();else void start()})
  if(app){app.ready();app.expand()}
  void start()
})()
