import { useEffect, useRef, useState } from 'react'
import { Download, FileUp, Printer, Trash2 } from 'lucide-react'
import type { MarketplaceItem } from '../models/Item'
import { documentKinds, type DocumentKind, type ItemDocument } from '../documents/itemDocuments'
import { downloadItemDocument, listItemDocuments, removeItemDocument, uploadItemDocument } from '../storage/itemDocumentsStore'
import './ItemDocuments.css'

export function ItemDocuments({ userId, item, readOnly = false }: { userId: string; item: MarketplaceItem; readOnly?: boolean }) {
  const [documents, setDocuments] = useState<ItemDocument[]>()
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [opened, setOpened] = useState<{ url: string; name: string }>()
  const active = useRef(false), pending = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => { return () => { if (opened) URL.revokeObjectURL(opened.url) } }, [opened])
  useEffect(() => {
    const controller = new AbortController()
    void listItemDocuments(userId, item.id, controller.signal).then(rows => { if (!controller.signal.aborted) setDocuments(rows) }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [userId, item.id, revision])
  async function run(action: () => Promise<void>) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setMessage(''); setOpened(undefined)
    try { await action() } catch (e) { if (active.current) setError((e as Error).message) }
    finally { pending.current = false; if (active.current) setBusy(false) }
  }
  return <section className="item-documents" aria-label="Item documents" aria-busy={busy}>
    <h3>Documents</h3>
    {(Object.entries(documentKinds) as [DocumentKind, string][]).map(([kind, label]) => <div className="item-document-group" key={kind}>
      <div className="document-heading"><h4>{label}</h4>{!readOnly && <label className="file-button"><FileUp size={16} /> Upload PDF<input type="file" accept="application/pdf,.pdf" aria-label={`Upload ${label.toLowerCase()}`} disabled={busy} onChange={e => {
        const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''
        if (file) void run(async () => { await uploadItemDocument(userId, item, kind, file); if (active.current) { setRevision(v => v + 1); setMessage(`${label} uploaded.`) } })
      }} /></label>}</div>
      {documents?.filter(d => d.kind === kind).map(d => <div className="item-document-row" key={d.id}>
        <span><strong>{d.filename}</strong><small>{d.pages} {d.pages === 1 ? 'page' : 'pages'}</small></span>
        <button type="button" className="icon-button" title={`Open ${d.filename}`} aria-label={`Open ${d.filename}`} disabled={busy} onClick={() => void run(async () => { const blob = await downloadItemDocument(userId, d); if (active.current) setOpened({ url: URL.createObjectURL(blob), name: d.filename }) })}><Printer size={18} /></button>
        {!readOnly && d.owner_id === userId && <button type="button" className="icon-button" title={`Remove ${d.filename}`} aria-label={`Remove ${d.filename}`} disabled={busy} onClick={() => {
          if (window.confirm(`Remove ${d.filename} from this item?`)) void run(async () => { const warning = await removeItemDocument(userId, d); if (active.current) { setRevision(v => v + 1); setMessage(warning ?? 'Document removed.') } })
        }}><Trash2 size={18} /></button>}
      </div>)}
      {documents && !documents.some(d => d.kind === kind) && <p className="document-muted">No PDF uploaded.</p>}
    </div>)}
    {!documents && !error && <p role="status">Loading documents...</p>}
    {busy && <p role="status">Preparing document...</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" disabled={busy} onClick={() => { setError(''); setRevision(v => v + 1) }}>Refresh documents</button></div>}
    {message && <p role="status">{message}</p>}
    {opened && <div className="document-links"><a href={opened.url} target="_blank" rel="noopener noreferrer"><Printer size={16} /> Open / print PDF</a><a href={opened.url} download={opened.name}><Download size={16} /> Download PDF</a></div>}
  </section>
}
