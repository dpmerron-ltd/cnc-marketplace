import { useEffect, useRef, useState } from 'react'
import { FileDown } from 'lucide-react'
import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'

export function TabMapDownload({ parts, sheet }: { parts: Part[]; sheet: Sheet }) {
  const mounted = useRef(false)
  const working = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function download() {
    if (working.current) return
    working.current = true; setBusy(true); setError('')
    try {
      const { buildTabMap } = await import('../printing/tabMap')
      const { createTabMapPdf } = await import('../printing/tabMapPdf')
      const { default: fontUrl } = await import('../../api/assets/NotoSans-Regular.ttf?url')
      const response = await fetch(fontUrl)
      if (!response.ok) throw new Error('Could not load the PDF font. Please retry.')
      const bytes = await createTabMapPdf(buildTabMap(parts, sheet), new Uint8Array(await response.arrayBuffer()))
      if (!mounted.current) return
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${sheet.name.replace(/[^a-z0-9_-]/gi, '-').slice(0, 100) || 'job'}-tab-map.pdf`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Could not create tab map PDF.') }
    finally { working.current = false; if (mounted.current) setBusy(false) }
  }
  return <div>
    <button type="button" className="icon-text-button" disabled={busy || !sheet.instances.length} onClick={() => void download()}><FileDown size={16} />{busy ? 'Preparing tab map...' : 'Tab map PDF'}</button>
    {error && <p role="alert">{error}</p>}
  </div>
}
