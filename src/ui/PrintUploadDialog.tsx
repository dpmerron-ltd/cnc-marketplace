import { useCallback, useEffect, useRef, useState } from 'react'
import { Cuboid, Package, Upload, X } from 'lucide-react'
import type { MarketplaceItem } from '../models/Item'
import { readStl } from '../printing/readStl'
import { dimensionLabel, maxStlBytes, type ParsedStl, type PrintableDetails } from '../printing/types'
import { uploadPrintable } from '../storage/printablesStore'
import { StlPreview } from './StlPreview'

export function PrintUploadDialog({ userId, items, onClose, onSaved }: { userId: string; items: MarketplaceItem[]; onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(false)
  const processing = useRef<AbortController | null>(null)
  const capture = useRef<(() => Promise<Blob>) | null>(null)
  const [previewReady, setPreviewReady] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [model, setModel] = useState<ParsedStl | null>(null)
  const [details, setDetails] = useState<PrintableDetails>({ name: '', purpose: 'product', item_id: null, notes: '', units: 'mm' })
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ready = useCallback((fn: () => Promise<Blob>) => { capture.current = fn; setPreviewReady(true) }, [])
  useEffect(() => { mounted.current = true; dialog.current?.showModal(); return () => { mounted.current = false; processing.current?.abort() } }, [])

  async function choose(next: File | undefined) {
    processing.current?.abort()
    capture.current = null; setPreviewReady(false); setModel(null); setFile(null); setError('')
    if (!next) { setReading(false); return }
    if (!/\.stl$/i.test(next.name) || next.size > maxStlBytes || !next.size) { setReading(false); setError('Choose a non-empty .stl file up to 25 MB.'); return }
    const controller = new AbortController(); processing.current = controller
    setReading(true)
    try {
      const parsed = await readStl(next, controller.signal)
      if (controller.signal.aborted || !mounted.current) return
      setFile(next); setModel(parsed); setDetails(d => ({ ...d, name: d.name || next.name.replace(/\.stl$/i, '').slice(0, 120) }))
    } catch (e) { if (!controller.signal.aborted && mounted.current) setError((e as Error).message) }
    finally { if (!controller.signal.aborted && mounted.current) setReading(false) }
  }
  async function save() {
    if (!file || !model || !capture.current || busy) return
    setBusy(true); setError('')
    try {
      const thumbnail = await capture.current()
      await uploadPrintable(userId, crypto.randomUUID(), details, file, thumbnail, model)
      if (mounted.current) onSaved()
    } catch (e) { if (mounted.current) setError((e as Error).message) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <dialog ref={dialog} className="print-dialog" aria-labelledby="print-upload-title" onCancel={e => { if (busy) e.preventDefault(); else onClose() }}>
    <div className="modal-header"><h2 id="print-upload-title">Upload 3D Print</h2><button type="button" className="icon-button" title="Close upload" aria-label="Close upload" disabled={busy} onClick={onClose}><X size={20} /></button></div>
    <form onSubmit={e => { e.preventDefault(); void save() }}>
      <fieldset disabled={busy} className="print-upload-fields">
        <label>STL file (max 25 MB)<input type="file" accept=".stl" aria-label="STL file" onChange={e => void choose(e.target.files?.[0])} /></label>
        {reading && <p role="status">Reading STL...</p>}
        {model && <><StlPreview model={model} name={details.name} onReady={ready} /><p className="print-mesh-info">{dimensionLabel(model.dimensions, details.units)} <span>{model.triangles.toLocaleString()} triangles</span></p></>}
        <div className="print-form-grid">
          <label>Name<input autoComplete="off" required maxLength={120} value={details.name} onChange={e => setDetails({ ...details, name: e.target.value })} /></label>
          <label>STL units<select value={details.units} onChange={e => setDetails({ ...details, units: e.target.value as PrintableDetails['units'] })}><option value="mm">Millimetres</option><option value="inches">Inches</option></select></label>
          <fieldset className="print-purpose"><legend>Purpose</legend><div role="group" aria-label="Purpose">{(['product', 'packaging'] as const).map(p => <button key={p} type="button" aria-pressed={details.purpose === p} className="icon-text-button" onClick={() => setDetails({ ...details, purpose: p })}>{p === 'product' ? <Cuboid size={16} /> : <Package size={16} />}{p === 'product' ? 'Product part' : 'Packaging'}</button>)}</div></fieldset>
          <label>Product (optional)<select value={details.item_id ?? ''} onChange={e => setDetails({ ...details, item_id: e.target.value || null })}><option value="">No linked product</option>{items.map(item => <option key={item.id} value={item.id}>{item.name} · {item.sku}</option>)}</select></label>
          <label className="print-notes-field">Print notes<textarea maxLength={4000} value={details.notes} onChange={e => setDetails({ ...details, notes: e.target.value })} /></label>
        </div>
      </fieldset>
      {error && <p role="alert" className="queue-error">{error}</p>}
      <div className="modal-actions"><button type="submit" className="primary icon-text-button" disabled={busy || reading || !file || !previewReady || !details.name.trim()}><Upload size={17} />{busy ? 'Uploading...' : 'Upload STL'}</button></div>
    </form>
  </dialog>
}
