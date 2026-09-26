import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Cuboid, Download, Package, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react'
import type { MarketplaceItem } from '../models/Item'
import { dimensionLabel, fileSizeLabel, purposeLabel, type ParsedStl, type PrintableAsset } from '../printing/types'
import { readStl } from '../printing/readStl'
import { downloadPrintable, listPrintables, printableThumbnails, printablesPageSize, removePrintable } from '../storage/printablesStore'
import { PrintUploadDialog } from './PrintUploadDialog'
import { StlPreview } from './StlPreview'
import './PrintablesPage.css'

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = filename.replace(/[/\\\x00-\x1f]/g, '_'); link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function PrintDetail({ asset, userId, item, onClose, onRemoved }: { asset: PrintableAsset; userId: string; item?: MarketplaceItem; onClose: () => void; onRemoved: (warning?: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(false)
  const [model, setModel] = useState<ParsedStl | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  useEffect(() => {
    mounted.current = true; dialog.current?.showModal()
    const controller = new AbortController()
    void downloadPrintable(userId, asset).then(blob => { controller.signal.throwIfAborted(); return readStl(blob, controller.signal) }).then(setModel).catch(e => { if (!controller.signal.aborted) setError((e as Error).message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { mounted.current = false; controller.abort() }
  }, [asset, userId])
  async function download() {
    setBusy(true); setError('')
    try { const blob = await downloadPrintable(userId, asset); if (mounted.current) saveBlob(blob, asset.filename) }
    catch (e) { if (mounted.current) setError((e as Error).message) }
    finally { if (mounted.current) setBusy(false) }
  }
  async function remove() {
    setBusy(true); setError('')
    try { const warning = await removePrintable(userId, asset); if (mounted.current) onRemoved(warning) }
    catch (e) { if (mounted.current) setError((e as Error).message) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <dialog ref={dialog} className="print-dialog" aria-labelledby="print-detail-title" onCancel={e => { if (busy) e.preventDefault(); else onClose() }}>
    <div className="modal-header"><h2 id="print-detail-title">{asset.name}</h2><button type="button" className="icon-button" title="Close preview" aria-label="Close preview" disabled={busy} onClick={onClose}><X size={20} /></button></div>
    {loading && <div className="print-loading" role="status">Loading STL...</div>}
    {model && <StlPreview model={model} name={asset.name} />}
    <dl className="print-detail-meta"><div><dt>Purpose</dt><dd>{purposeLabel(asset.purpose)}</dd></div><div><dt>Dimensions</dt><dd>{dimensionLabel(asset.dimensions, asset.units)}</dd></div><div><dt>Product</dt><dd>{item ? `${item.name} · ${item.sku}` : 'No linked product'}</dd></div><div><dt>File</dt><dd>{asset.filename} · {fileSizeLabel(asset.file_bytes)}</dd></div></dl>
    {asset.notes && <section className="print-detail-notes"><h3>Print Notes</h3><p>{asset.notes}</p></section>}
    {error && <p role="alert" className="queue-error">{error}</p>}
    {confirmRemove ? <div className="print-remove-confirm"><p>Remove <strong>{asset.name}</strong> from the shared library?</p><div className="button-row"><button type="button" className="danger icon-text-button" disabled={busy} onClick={() => void remove()}><Trash2 size={16} />Remove STL</button><button type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</button></div></div> : <div className="print-detail-actions">{asset.owner_id === userId && <button type="button" className="icon-button danger" title="Remove STL" aria-label="Remove STL" disabled={busy} onClick={() => setConfirmRemove(true)}><Trash2 size={18} /></button>}<button type="button" className="primary icon-text-button" disabled={busy} onClick={() => void download()}><Download size={17} />{busy ? 'Downloading...' : 'Download STL'}</button></div>}
  </dialog>
}

export function PrintablesPage({ userId, items }: { userId: string; items: MarketplaceItem[] }) {
  const [assets, setAssets] = useState<PrintableAsset[]>([])
  const [count, setCount] = useState(0)
  const [images, setImages] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState({ search: '', purpose: '', item: '', page: 0 })
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [uploading, setUploading] = useState(false)
  const [selected, setSelected] = useState<PrintableAsset | null>(null)
  const [downloading, setDownloading] = useState('')
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { const timer = setTimeout(() => setFilters(f => ({ ...f, search, page: 0 })), 250); return () => clearTimeout(timer) }, [search])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setAssets([]); setImages({})
    void listPrintables(userId, filters, controller.signal).then(async result => {
      if (controller.signal.aborted) return
      setAssets(result.assets); setCount(result.count)
      const urls = await printableThumbnails(userId, result.assets)
      if (!controller.signal.aborted) setImages(urls)
    }).catch(e => { if (!controller.signal.aborted) setError((e as Error).message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    const renew = setInterval(() => setRevision(r => r + 1), 8 * 60 * 1000)
    return () => { controller.abort(); clearInterval(renew) }
  }, [userId, filters, revision])
  async function download(asset: PrintableAsset) {
    setDownloading(asset.id); setError('')
    try { const blob = await downloadPrintable(userId, asset); if (mounted.current) saveBlob(blob, asset.filename) }
    catch (e) { if (mounted.current) setError((e as Error).message) }
    finally { if (mounted.current) setDownloading('') }
  }
  function refreshed(message: string) { setNotice(message); setFilters(f => ({ ...f, page: 0 })); setRevision(r => r + 1) }
  return <main className="prints-page">
    <header className="prints-heading"><div><h2>3D Prints</h2><p>{count} shared {count === 1 ? 'file' : 'files'}</p></div><div className="button-row"><button type="button" className="icon-button" title="Refresh 3D prints" aria-label="Refresh 3D prints" disabled={loading} onClick={() => setRevision(r => r + 1)}><RefreshCw size={18} /></button><button type="button" className="primary icon-text-button" onClick={() => setUploading(true)}><Upload size={17} />Upload STL</button></div></header>
    <div className="prints-filters"><label className="prints-search"><Search size={17} /><input type="search" aria-label="Search 3D prints" placeholder="Search 3D prints" value={search} onChange={e => setSearch(e.target.value)} /></label><label>Purpose<select value={filters.purpose} onChange={e => setFilters(f => ({ ...f, purpose: e.target.value, page: 0 }))}><option value="">All purposes</option><option value="product">Product parts</option><option value="packaging">Packaging</option></select></label><label>Product<select value={filters.item} onChange={e => setFilters(f => ({ ...f, item: e.target.value, page: 0 }))}><option value="">All products</option>{items.map(item => <option key={item.id} value={item.id}>{item.name} · {item.sku}</option>)}</select></label></div>
    {notice && <p role="status" className="prints-notice">{notice}</p>}
    {downloading && <p role="status">Downloading STL...</p>}
    {error && <p role="alert" className="queue-error">{error}</p>}
    {loading && <p role="status">Loading 3D prints...</p>}
    {!loading && !error && !assets.length && <div className="prints-empty"><Cuboid size={40} /><h3>{filters.search || filters.item || filters.purpose ? 'No matching files' : 'No 3D prints yet'}</h3></div>}
    <div className="prints-grid">{assets.map(asset => { const item = items.find(i => i.id === asset.item_id); return <article className="print-card" key={asset.id}>
      <button type="button" className="print-card-preview" aria-label={`Preview ${asset.name}`} onClick={() => setSelected(asset)}>{images[asset.preview_path] ? <img src={images[asset.preview_path]} alt={asset.name} loading="lazy" onError={() => setImages(current => { const next = { ...current }; delete next[asset.preview_path]; return next })} /> : <Cuboid size={42} />}</button>
      <div className="print-card-info"><span className={`print-category ${asset.purpose}`}>{asset.purpose === 'product' ? <Cuboid size={14} /> : <Package size={14} />}{purposeLabel(asset.purpose)}</span><h3><button type="button" onClick={() => setSelected(asset)}>{asset.name}</button></h3><p className="print-product">{item ? item.name : 'No linked product'}</p><p className="print-dimensions">{dimensionLabel(asset.dimensions, asset.units)}</p><footer><span>{fileSizeLabel(asset.file_bytes)} · STL</span><button type="button" className="icon-button" title={`Download ${asset.name}`} aria-label={`Download ${asset.name}`} disabled={Boolean(downloading)} onClick={() => void download(asset)}><Download size={18} /></button></footer></div>
    </article> })}</div>
    {count > printablesPageSize && <nav className="prints-pagination" aria-label="3D prints pages"><button type="button" className="icon-button" title="Previous page" aria-label="Previous page" disabled={loading || !filters.page} onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}><ChevronLeft size={18} /></button><span>Page {filters.page + 1} of {Math.ceil(count / printablesPageSize)}</span><button type="button" className="icon-button" title="Next page" aria-label="Next page" disabled={loading || (filters.page + 1) * printablesPageSize >= count} onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}><ChevronRight size={18} /></button></nav>}
    {uploading && <PrintUploadDialog userId={userId} items={items} onClose={() => setUploading(false)} onSaved={() => { setUploading(false); refreshed('STL uploaded.'); }} />}
    {selected && <PrintDetail asset={selected} userId={userId} item={items.find(i => i.id === selected.item_id)} onClose={() => setSelected(null)} onRemoved={warning => { setSelected(null); refreshed(warning || 'STL removed.'); }} />}
  </main>
}
