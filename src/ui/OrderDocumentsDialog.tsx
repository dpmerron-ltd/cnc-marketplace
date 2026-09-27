import { useEffect, useRef, useState } from 'react'
import { Download, Printer, X } from 'lucide-react'
import type { MarketplaceItem } from '../models/Item'
import type { ShopifyOrder } from '../orders/types'
import { matchOrderItems } from '../orders/addOrderToSheet'
import { loadCompleteOrder } from '../orders/loadCompleteOrder'
import { createPrintPacket, documentKinds, type ItemDocument } from '../documents/itemDocuments'
import { downloadItemDocument, listItemDocuments } from '../storage/itemDocumentsStore'
import './ItemDocuments.css'

export function OrderDocumentsDialog({ userId, orderId, items, onClose }: { userId: string; orderId: string; items: MarketplaceItem[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [order, setOrder] = useState<ShopifyOrder>()
  const [matches, setMatches] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const initialItems = useRef(items)
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    const controller = new AbortController()
    void loadCompleteOrder(userId, orderId, controller.signal).then(data => {
      if (controller.signal.aborted) return
      setOrder(data.order); setMatches(matchOrderItems(data.order, initialItems.current, userId))
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [userId, orderId, retry])
  return <dialog ref={dialog} className="order-sheet-dialog" aria-labelledby="order-documents-title" onCancel={onClose}>
    <div className="queue-heading"><h3 id="order-documents-title">Print documents {order?.name}</h3><button type="button" className="icon-button" title="Close" aria-label="Close documents" onClick={onClose}><X size={18} /></button></div>
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => { setError(''); setRetry(v => v + 1) }}>Retry</button></div>}
    {!order && !error && <p role="status">Loading all order items...</p>}
    {order && <>
      {order.lineItems.nodes.filter(line => line.currentQuantity > 0).map(line => <div className="order-sheet-line" key={line.id}>
        <strong>{line.currentQuantity} x {line.title}</strong><span>SKU: {line.sku || 'Not supplied'}</span>
        <label>Catalogue item<select aria-label={`Document item for ${line.title}`} value={matches[line.id] ?? ''} onChange={e => setMatches(previous => ({ ...previous, [line.id]: e.target.value }))}>
          <option value="">Select item</option>{items.map(item => <option key={item.id} value={item.id}>{item.sku} / {item.name}</option>)}
        </select></label>
        {!matches[line.id] && <p role="status">No unique catalogue match. Select the item to find its documents.</p>}
      </div>)}
      <OrderDocumentSelection key={JSON.stringify(matches)} userId={userId} order={order} matches={matches} />
    </>}
  </dialog>
}

function OrderDocumentSelection({ userId, order, matches }: { userId: string; order: ShopifyOrder; matches: Record<string, string> }) {
  const [rows, setRows] = useState<{ key: string; document: ItemDocument; title: string; copies: number; selected: boolean }[]>()
  const [missing, setMissing] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const [url, setUrl] = useState('')
  const active = useRef(false), pending = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const result: NonNullable<typeof rows> = [], absent: string[] = []
        const cache = new Map<string, ItemDocument[]>()
        for (const line of order.lineItems.nodes.filter(l => l.currentQuantity > 0)) {
          const item = matches[line.id]
          if (!item) { absent.push(`${line.title}: catalogue item not selected.`); continue }
          const documents = cache.get(item) ?? await listItemDocuments(userId, item, controller.signal)
          controller.signal.throwIfAborted(); cache.set(item, documents)
          for (const [kind, label] of Object.entries(documentKinds)) if (!documents.some(d => d.kind === kind)) absent.push(`${line.title}: ${label.toLowerCase()} not uploaded.`)
          for (const document of documents) result.push({ key: `${line.id}:${document.id}`, document, title: line.title, copies: line.currentQuantity, selected: true })
        }
        if (!controller.signal.aborted) { setRows(result); setMissing(absent) }
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message) }
    })()
    return () => controller.abort()
  }, [userId, order, matches, retry])
  const selected = rows?.filter(r => r.selected) ?? []
  async function prepare() {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setUrl('')
    try {
      const blob = await createPrintPacket(selected, async document => {
        if (!active.current) throw new Error('Print cancelled.')
        return downloadItemDocument(userId, document)
      })
      if (active.current) setUrl(URL.createObjectURL(blob))
    } catch (e) { if (active.current) setError((e as Error).message) }
    finally { pending.current = false; if (active.current) setBusy(false) }
  }
  return <div>
    {!rows && !error && <p role="status">Loading document list...</p>}
    {missing.length > 0 && <div role="status"><h4>Missing documents</h4><ul>{missing.map((m, i) => <li key={i}>{m}</li>)}</ul></div>}
    {rows?.map(row => <div className="document-selection" key={row.key}>
      <label><input type="checkbox" checked={row.selected} disabled={busy} onChange={e => { setUrl(''); setRows(previous => previous?.map(r => r.key === row.key ? { ...r, selected: e.target.checked } : r)) }} /><span>{row.title}<br /><strong>{documentKinds[row.document.kind]}</strong><br /><small>{row.document.filename} / {row.document.pages} pages</small></span></label>
      <label>Copies<input type="number" aria-label={`Copies of ${row.document.filename} for ${row.title}`} min={1} max={100} step={1} value={row.copies} disabled={busy || !row.selected} onChange={e => { setUrl(''); setRows(previous => previous?.map(r => r.key === row.key ? { ...r, copies: Number(e.target.value) } : r)) }} /></label>
    </div>)}
    {rows && !rows.length && <p>No documents available to print.</p>}
    {error && <div role="alert"><p>{error}</p>{!rows && <button type="button" onClick={() => { setError(''); setRetry(v => v + 1) }}>Retry documents</button>}</div>}
    <div className="order-sheet-actions"><span>{selected.reduce((sum, r) => sum + r.copies * r.document.pages, 0)} pages selected</span><button type="button" className="icon-text-button" disabled={!selected.length || busy} onClick={() => void prepare()}><Printer size={16} /> {busy ? 'Preparing PDF...' : 'Prepare print PDF'}</button></div>
    {url && <div className="document-links"><a href={url} target="_blank" rel="noopener noreferrer"><Printer size={16} /> Open / print PDF</a><a href={url} download={`${order.name.replace(/[^a-zA-Z0-9_-]/g, '')}-documents.pdf`}><Download size={16} /> Download PDF</a></div>}
  </div>
}
