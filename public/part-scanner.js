(() => {
  const app = window.Telegram?.WebApp
  const scan = document.getElementById('scan')
  const lookup = document.getElementById('lookup')
  const status = document.getElementById('status')
  const loading = document.getElementById('loading')
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  let sent = false
  let scanning = false
  function partId(raw) {
    const text = String(raw).trim()
    if (uuid.test(text)) return text.toLowerCase()
    if (/^CNC:PART:/i.test(text) && uuid.test(text.slice(9))) return text.slice(9).toLowerCase()
    try {
      const url = new URL(text)
      if (url.protocol !== 'https:' || url.hostname !== 't.me' || url.pathname !== '/tripleeightgroup_bot') return
      const payload = url.searchParams.get('start')
      if (payload?.startsWith('part_') && uuid.test(payload.slice(5))) return payload.slice(5).toLowerCase()
    } catch { /* A different barcode is never followed as a link. */ }
  }
  const inTelegram = Boolean(app && app.platform !== 'unknown' && typeof app.sendData === 'function')
  function submit(raw) {
    if (sent) return true
    const id = partId(raw)
    if (!id) { status.textContent = 'That is not a CNC part QR code or full part ID. Try another label.'; return false }
    if (!inTelegram) { status.textContent = 'Open /scan in the Telegram bot, then tap Scan part QR.'; return false }
    try {
      sent = true; scan.disabled = true; lookup.disabled = true; loading.hidden = false
      status.textContent = 'Opening this part in the bot chat…'
      app.sendData(JSON.stringify({ type: 'part_lookup', id }))
      return true
    } catch {
      sent = false; scan.disabled = false; lookup.disabled = false; loading.hidden = true
      status.textContent = 'Could not return to Telegram. Reopen /scan from the bot keyboard and try again.'
      return false
    }
  }
  function start() {
    if (sent || scanning) return
    if (!inTelegram) { status.textContent = 'Open /scan in the Telegram bot, then tap Scan part QR.'; return }
    if (!['android', 'android_x', 'ios'].includes(app.platform) || !app.isVersionAtLeast?.('7.7')) {
      status.textContent = 'Use Telegram on an updated iPhone or Android phone for the camera scanner. You can enter the part ID below on this device.'
      return
    }
    try {
      scanning = true
      status.textContent = 'Point the camera at one part QR. If the camera does not open, check Telegram’s camera permission or enter the ID below.'
      app.showScanQrPopup({text:'Point the camera at one CNC part QR label'}, data => {
        const id = partId(data)
        if (!id) { status.textContent = 'Not a CNC part QR code. Try the code on a part label.'; return false }
        app.closeScanQrPopup(); scanning = false
        return submit(id)
      })
    } catch {
      scanning = false
      status.textContent = 'Camera scanning is unavailable here. Check Telegram’s camera permission, or enter the part ID below.'
    }
  }
  scan.addEventListener('click', start)
  document.getElementById('manual').addEventListener('submit', event => { event.preventDefault(); submit(document.getElementById('part-id').value) })
  if (inTelegram) {
    app.ready(); app.expand()
    app.onEvent('scanQrPopupClosed', () => { scanning = false; if (!sent) status.textContent = 'Scanner closed. Tap the camera button to try again, or enter the ID below.' })
    start()
  } else {
    status.textContent = 'Open /scan in @tripleeightgroup_bot, then tap Scan part QR.'
    scan.disabled = true; lookup.disabled = true
  }
})()
