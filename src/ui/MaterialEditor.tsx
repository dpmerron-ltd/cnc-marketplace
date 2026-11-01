import { useState } from 'react'
import type { MarketplaceItem } from '../models/Item'
import type { Part } from '../models/Part'
import { stockMaterialSchema, stockLabel, type StockMaterial } from '../models/stockMaterial'

const blank: StockMaterial = { thicknessMm: 12, type: 'Plywood', finish: 'Natural' }
export function StockFields({ value, onChange, label, disabled = false }: { value: StockMaterial; onChange: (value: StockMaterial) => void; label: string; disabled?: boolean }) {
  return <div className="stock-fields">
    <label>Stock thickness (mm)<input aria-label={`${label} stock thickness`} type="number" min="0.1" max="100" step="0.1" disabled={disabled} value={value.thicknessMm || ''} onChange={e => onChange({ ...value, thicknessMm: Number(e.target.value) })} /></label>
    <label>Material type<input aria-label={`${label} material type`} disabled={disabled} value={value.type} onChange={e => onChange({ ...value, type: e.target.value })} placeholder="Plywood" /></label>
    <label>Finish<input aria-label={`${label} finish`} disabled={disabled} value={value.finish} onChange={e => onChange({ ...value, finish: e.target.value })} placeholder="Natural / Black hex" /></label>
  </div>
}
export function MaterialEditor({ item, parts, readOnly, onSave }: { item: MarketplaceItem; parts: Part[]; readOnly: boolean; onSave: (stock: StockMaterial | undefined, overrides: Record<string, StockMaterial | null>) => Promise<void> }) {
  const [stock, setStock] = useState(item.defaultMaterial)
  const [overrides, setOverrides] = useState<Record<string, StockMaterial | null>>(Object.fromEntries(parts.map(p => [p.id, p.stockMaterial ?? null])))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false)
  return <section className="material-editor" aria-label="Item materials"><h3>Materials and finishes</h3>
    <p>Set the actual stock for the item, then override any parts that use another thickness or finish. The cutting preset is chosen separately on each sheet.</p>
    <label><input type="checkbox" checked={Boolean(stock)} disabled={readOnly || busy} onChange={e => { setStock(e.target.checked ? { ...blank } : undefined); setSaved(false) }} /> Use a default material for this item</label>
    {stock && <StockFields label="Item default" value={stock} disabled={readOnly || busy} onChange={value => { setStock(value); setSaved(false) }} />}
    <details><summary>Part material overrides ({parts.length} parts)</summary>{parts.map(part => <fieldset key={part.id} disabled={readOnly || busy}><legend>{part.name} · {part.sku}</legend>
      <label><input type="checkbox" checked={Boolean(overrides[part.id])} onChange={e => { setOverrides(old => ({ ...old, [part.id]: e.target.checked ? { ...(stock ?? blank) } : null })); setSaved(false) }} /> Use a different material</label>
      {overrides[part.id] ? <StockFields label={part.name} value={overrides[part.id]!} onChange={value => { setOverrides(old => ({ ...old, [part.id]: value })); setSaved(false) }} /> : <p>{stock ? `Uses item default: ${stockLabel(stock)}` : 'Material not specified. Assign stock when planning the sheet.'}</p>}
    </fieldset>)}</details>
    {!readOnly && <button type="button" disabled={busy} onClick={async () => { setBusy(true); setError(''); try {
      const parsed = stock ? stockMaterialSchema.parse(stock) : undefined
      const values = Object.fromEntries(Object.entries(overrides).map(([id,value]) => [id, value ? stockMaterialSchema.parse(value) : null]))
      await onSave(parsed, values); setSaved(true)
    } catch(e) { setError(e instanceof Error ? e.message : 'Could not save materials.') } finally { setBusy(false) } }}>{busy ? 'Saving materials…' : 'Save materials'}</button>}
    {error && <p role="alert">{error}</p>}{saved && <p role="status">Materials saved for new additions. Existing cutting jobs keep their saved requirements.</p>}
  </section>
}
