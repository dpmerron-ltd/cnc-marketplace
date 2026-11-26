import { useEffect, useRef, useState } from 'react'
import { Download, Printer } from 'lucide-react'
import { createPackagingLabelPdf, packagingLabels, renderPackagingLabel, validateLabelQuantity, type PackagingLabel } from '../labels/packagingLabels'
import './LabelsPage.css'

function LabelCard({ label }: { label: PackagingLabel }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [quantity, setQuantity] = useState(1)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    if (canvas.current) void renderPackagingLabel(canvas.current, label).then(() => {
      if (!cancelled) setReady(true)
    }).catch(error => { if (!cancelled) setError((error as Error).message) })
    return () => { cancelled = true }
  }, [label])

  async function download() {
    setBusy(true)
    setError('')
    try {
      const blob = await createPackagingLabelPdf(label, quantity)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `888-${label.id}-labels.pdf`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }

  function print() {
    setError('')
    try {
      validateLabelQuantity(quantity)
      const data = canvas.current!.toDataURL('image/png')
      const popup = window.open('', '_blank')
      if (!popup) throw new Error('Allow pop-ups to print, or download the PDF instead.')
      popup.document.title = `888 Van Racking - ${label.title}`
      const style = popup.document.createElement('style')
      style.textContent = `@page { size: ${label.width}mm ${label.height}mm; margin: 0; } * { box-sizing: border-box; } body { margin: 0; } img { display: block; width: ${label.width}mm; height: ${label.height}mm; break-after: page; } img:last-child { break-after: auto; }`
      popup.document.head.append(style)
      const images = Array.from({ length: quantity }, () => {
        const img = popup.document.createElement('img')
        img.alt = label.title
        img.src = data
        popup.document.body.append(img)
        return img.decode()
      })
      void Promise.all(images).then(() => { popup.focus(); popup.print() }).catch(() => {
        popup.close()
        setError('Could not prepare printing. Please download the PDF instead.')
      })
    } catch (error) { setError((error as Error).message) }
  }

  return <section className="packaging-label-card" aria-labelledby={`${label.id}-title`}>
    <h3 id={`${label.id}-title`}>{label.title}</h3>
    <p>{label.size}{label.id !== 'fitting-kit' ? ' · CNC part label size' : ' · Thermal postage label'}</p>
    <div className="packaging-label-preview"><canvas ref={canvas} aria-label={`${label.title}${label.instruction ? `. ${label.instruction}` : ''}`} style={{ aspectRatio: `${label.width} / ${label.height}` }} /></div>
    <label className="packaging-label-quantity">Quantity<input type="number" min={1} max={100} step={1} value={quantity} onChange={event => setQuantity(Number(event.target.value))} /></label>
    <div className="packaging-label-actions">
      <button type="button" className="primary icon-text-button" disabled={!ready || busy} onClick={print}><Printer size={16} />Print</button>
      <button type="button" className="icon-text-button" disabled={!ready || busy} onClick={() => void download()}><Download size={16} />{busy ? 'Preparing…' : 'Download PDF'}</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </section>
}

export function LabelsPage() {
  return <main className="packaging-labels-page">
    <h2>Labels</h2>
    <p>Branded labels for fitting kits and order hardware. Choose a label and quantity to print.</p>
    <p>Print at actual size (100%) with no margins or headers and footers. Select the matching label size in your printer settings.</p>
    <div className="packaging-labels-grid">{packagingLabels.map(label => <LabelCard key={label.id} label={label} />)}</div>
  </main>
}
