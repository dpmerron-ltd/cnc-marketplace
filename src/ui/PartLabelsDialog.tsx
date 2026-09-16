import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react'
import type { MarketplaceItem } from '../models/Item'
import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import { buildPartLabels, labelPageLayout, type LabelLayout } from '../labels/partLabels'
import { createLabelPdf, renderLabel } from '../labels/labelPdf'

export function PartLabelsDialog({ parts, items, sheet, sheetIndex, onClose }: { parts: Part[]; items: MarketplaceItem[]; sheet: Sheet; sheetIndex: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const mounted = useRef(false)
  const [layout, setLayout] = useState<LabelLayout>({ width: 50, height: 25, format: 'single' })
  const [scope, setScope] = useState('current')
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const result = useMemo(() => {
    try {
      labelPageLayout(layout)
      const labels = buildPartLabels(parts, items, sheet).filter(label => scope === 'all' || label.sheetNumber === sheetIndex + 1)
      return { labels, error: '' }
    } catch (error) { return { labels: [], error: (error as Error).message } }
  }, [parts, items, sheet, sheetIndex, scope, layout])
  const selected = Math.min(index, Math.max(0, result.labels.length - 1))
  useEffect(() => {
    mounted.current = true
    dialog.current?.showModal()
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (canvas.current && result.labels[selected]) renderLabel(canvas.current, result.labels[selected], layout)
  }, [result, selected, layout])

  async function download() {
    setBusy(true)
    setError('')
    try {
      const blob = await createLabelPdf(result.labels, layout)
      if (!mounted.current) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${sheet.name.replace(/[^a-z0-9_-]/gi, '-').slice(0, 100) || 'job'}-${scope === 'all' ? 'all-sheets' : `sheet-${sheetIndex + 1}`}-labels.pdf`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { if (mounted.current) setError((error as Error).message) }
    finally { if (mounted.current) setBusy(false) }
  }

  return <dialog ref={dialog} className="label-dialog" onCancel={onClose} aria-labelledby="labels-title">
    <div className="modal-header">
      <h2 id="labels-title">Part Labels</h2>
      <button type="button" className="icon-button" title="Close labels" aria-label="Close labels" onClick={onClose}><X size={20} /></button>
    </div>
    <div className="label-fields">
      <label>Width (mm)<input type="number" min={40} max={190} step={0.5} value={layout.width} onChange={event => setLayout({ ...layout, width: Number(event.target.value) })} /></label>
      <label>Height (mm)<input type="number" min={20} max={277} step={0.5} value={layout.height} onChange={event => setLayout({ ...layout, height: Number(event.target.value) })} /></label>
      <label>Page format<select value={layout.format} onChange={event => setLayout({ ...layout, format: event.target.value as LabelLayout['format'] })}><option value="single">One label per page</option><option value="a4">A4 grid</option></select></label>
      <label>Parts<select value={scope} onChange={event => { setScope(event.target.value); setIndex(0) }}><option value="current">Sheet {sheetIndex + 1}</option><option value="all">All sheets</option></select></label>
    </div>
    {result.labels.length > 0 && <>
      <div className="label-preview"><canvas ref={canvas} aria-label={`Label ${result.labels[selected].partNumber}`} style={{ aspectRatio: `${layout.width} / ${layout.height}` }} /></div>
      <div className="label-pagination">
        <button type="button" className="icon-button" title="Previous label" aria-label="Previous label" disabled={!selected} onClick={() => setIndex(selected - 1)}><ChevronLeft size={18} /></button>
        <span>{selected + 1} / {result.labels.length}</span>
        <button type="button" className="icon-button" title="Next label" aria-label="Next label" disabled={selected === result.labels.length - 1} onClick={() => setIndex(selected + 1)}><ChevronRight size={18} /></button>
      </div>
    </>}
    {(result.error || error) && <p role="alert">{result.error || error}</p>}
    {!result.error && !result.labels.length && <p>No parts on this sheet.</p>}
    <div className="modal-actions"><button type="button" className="primary icon-text-button" disabled={busy || !result.labels.length} onClick={() => void download()}><Download size={16} />{busy ? 'Preparing PDF...' : `Download ${result.labels.length} labels`}</button></div>
  </dialog>
}
