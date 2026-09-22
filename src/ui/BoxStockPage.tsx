import { useRef, useState } from 'react'
import { Plus, RefreshCw, Save, X } from 'lucide-react'
import type { MarketplaceItem } from '../models/Item'
import type { ComponentSummary } from '../models/Part'
import type { BoxStock } from '../packing/boxStock'
import { boxSize } from '../packing/format'
import { packingPieces } from '../packing/packing'
import { usePackingEstimates } from '../packing/usePackingEstimates'
import { useBoxStock } from '../storage/useBoxStock'
import { jobApiRequest } from '../storage/jobsApi'
import './BoxStockPage.css'

function StockCount({ box, userId, onSaved }: { box: BoxStock; userId: string; onSaved: () => void }) {
  const [quantity, setQuantity] = useState(String(box.quantity))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const valid = quantity !== '' && Number.isInteger(Number(quantity)) && Number(quantity) >= 0 && Number(quantity) <= 100000
  async function save() {
    setBusy(true); setError('')
    try { await jobApiRequest(`/boxes/${box.id}`, userId, { method: 'PATCH', body: JSON.stringify({ quantity: Number(quantity), expectedVersion: box.version }) }); onSaved() }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  return <><div className="stock-count"><input aria-label={`Stock count for ${box.name}`} type="number" min="0" max="100000" step="1" value={quantity} disabled={busy} onChange={e => setQuantity(e.target.value)} /><button type="button" className="icon-button" title="Save stock count" aria-label={`Save stock count for ${box.name}`} disabled={busy || !valid || Number(quantity) === box.quantity} onClick={() => void save()}><Save size={17} /></button></div>{error && <p role="alert" className="queue-error">{error}</p>}</>
}

export function BoxStockPage({ userId, items, parts }: { userId: string; items: MarketplaceItem[]; parts: ComponentSummary[] }) {
  const stock = useBoxStock(userId)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', length: '', width: '', height: '', quantity: '0' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const newId = useRef(crypto.randomUUID())
  const sharedItems = items.filter(i => parts.some(p => p.itemId === i.id))
  const jobs = stock.boxes ? JSON.stringify(sharedItems.map(item => ({ id: item.id, pieces: packingPieces(parts.filter(p => p.itemId === item.id), item.packing), settings: item.packing, boxes: stock.boxes }))) : undefined
  const estimates = usePackingEstimates(jobs)
  const suggestions = new Map<string, string[]>()
  for (const item of sharedItems) {
    const estimate = estimates[item.id]?.result, suggestion = estimate?.suggestedBox
    if (!suggestion || !estimate) continue
    const stockVolume = estimate.boxes.reduce((sum, b) => sum + b.volumeLitres, 0)
    if (estimate.boxes.every(b => b.stockId) && estimate.boxes.length === 1 && suggestion.volumeLitres >= stockVolume * 0.75) continue
    const size = boxSize(suggestion.internal)
    suggestions.set(size, [...(suggestions.get(size) ?? []), item.name])
  }
  async function add() {
    setBusy(true); setError('')
    try {
      await jobApiRequest('/boxes', userId, { method: 'POST', body: JSON.stringify({ id: newId.current, name: form.name, length_mm: Math.round(Number(form.length) * 10), width_mm: Math.round(Number(form.width) * 10), height_mm: Math.round(Number(form.height) * 10), quantity: Number(form.quantity), details: 'Internal dimensions.' }) })
      newId.current = crypto.randomUUID(); setAdding(false); setForm({ name: '', length: '', width: '', height: '', quantity: '0' }); stock.reload()
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  return <main className="queue-page box-stock-page">
    <div className="queue-heading"><h2>Shared Box Stock</h2><div className="button-row"><button type="button" className="icon-text-button" onClick={() => setAdding(true)}><Plus size={17} /> Add box size</button><button type="button" className="icon-button" aria-label="Refresh box stock" title="Refresh box stock" disabled={stock.loading} onClick={stock.reload}><RefreshCw size={18} /></button></div></div>
    {(stock.error || error) && <p role="alert" className="queue-error">{stock.error || error}</p>}
    {stock.loading && <p role="status">Loading box stock...</p>}
    {adding && <form className="box-create" onSubmit={e => { e.preventDefault(); void add() }}><label>Name<input required maxLength={100} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>{(['length', 'width', 'height'] as const).map(field => <label key={field}>Internal {field} (cm)<input required type="number" min="1" max="120" step="0.1" value={form[field]} onChange={e => setForm({ ...form, [field]: e.target.value })} /></label>)}<label>Quantity<input required type="number" min="0" max="100000" step="1" value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} /></label><button type="submit" className="icon-text-button" disabled={busy}><Save size={17} /> Save box</button><button type="button" className="icon-button" title="Cancel new box" aria-label="Cancel new box" disabled={busy} onClick={() => setAdding(false)}><X size={17} /></button></form>}
    {stock.boxes && <><div className="queue-table-scroll"><table className="queue-table box-inventory"><thead><tr><th>Box</th><th>Internal dimensions</th><th>In stock</th></tr></thead><tbody>{stock.boxes.map(box => <tr key={box.id}><td>{box.name}<span className="stock-mobile-dimensions">{boxSize({ length: box.length_mm, width: box.width_mm, height: box.height_mm })} internal</span><span className="queue-order">{box.details}</span></td><td>{boxSize({ length: box.length_mm, width: box.width_mm, height: box.height_mm })}</td><td><StockCount key={`${box.id}:${box.version}`} box={box} userId={userId} onSaved={stock.reload} /></td></tr>)}</tbody></table></div>{!stock.boxes.length && <p>No shared box sizes.</p>}
      <section className="box-fit-section"><h3>Item Packing</h3><div className="queue-table-scroll"><table className="queue-table"><thead><tr><th>Item</th><th>Recommended box</th><th>Per-item availability</th></tr></thead><tbody>{sharedItems.map(item => { const result = estimates[item.id]; return <tr key={item.id}><td>{item.name}<span className="queue-order">{item.sku}</span></td><td>{result?.result?.boxes.length ? result.result.boxes.map((b, i) => <div key={i}>{b.stockName || boxSize(b.internal)}{!b.stockId ? ' (new size)' : ''}</div>) : result?.error || result?.result?.errors.join(' ') || 'Calculating...'}</td><td>{result?.result?.boxes.length ? result.result.boxes.every(b => b.stockId) ? result.result.warnings.some(w => w.startsWith('Replenish')) ? 'Restock required' : `${result.result.boxes.length} box${result.result.boxes.length === 1 ? '' : 'es'} available` : 'Order new size' : ''}</td></tr> })}</tbody></table></div></section>
      <section className="box-fit-section"><h3>Suggested Sizes To Order</h3>{[...suggestions].length ? <ul className="box-suggestions">{[...suggestions].sort((a, b) => b[1].length - a[1].length).map(([size, names]) => <li key={size}><strong>{size} internal</strong><span>{names.join(', ')}</span></li>)}</ul> : <p>{sharedItems.some(i => !estimates[i.id]) ? 'Calculating suggestions...' : 'No additional size suggested from the current components.'}</p>}</section>
    </>}
  </main>
}
