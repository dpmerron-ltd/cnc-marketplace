import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, FileUp, Package, Plus, Search, Trash2, X } from 'lucide-react'
import type { MarketplaceItem } from '../models/Item'
import type { Part } from '../models/Part'
import { ItemPreview } from './ItemPreview'
import { PackingPanel } from './PackingPanel'
import { boxSize } from '../packing/format'
import { packingPieces } from '../packing/packing'
import type { PackingEstimate } from '../packing/types'
import './MarketplacePage.css'

interface MarketplacePageProps {
  items: MarketplaceItem[]
  parts: Part[]
  currentUserId?: string
  onCreateItem: () => string
  onSelectItem: (itemId: string) => void
  onUpdateItem: (itemId: string, patch: Partial<MarketplaceItem>) => void
  onImportComponents: (itemId: string, files: FileList) => void
  onDeleteComponent: (partId: string) => void
  onAddToSheet: (partId: string) => void
  onOpenSheet: () => void
}

function dateLabel(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function MarketplacePage({ items, parts, currentUserId, onCreateItem, onSelectItem, onUpdateItem, onImportComponents, onDeleteComponent, onAddToSheet, onOpenSheet }: MarketplacePageProps) {
  const [detailId, setDetailId] = useState<string>()
  const [query, setQuery] = useState('')
  const [componentQuery, setComponentQuery] = useState('')
  const [sort, setSort] = useState('name')
  const [filter, setFilter] = useState('all')
  const [added, setAdded] = useState<string>()
  const ownItems = useMemo(() => items.filter(item => currentUserId && item.ownerId === currentUserId), [items, currentUserId])
  const partsByItem = useMemo(() => {
    const map = new Map<string, Part[]>()
    for (const part of parts) {
      if (!part.itemId || part.ownerId !== currentUserId) continue
      const group = map.get(part.itemId) ?? []
      group.push(part)
      map.set(part.itemId, group)
    }
    return map
  }, [parts, currentUserId])
  const packingJobs = JSON.stringify(ownItems.map(item => ({ id: item.id, pieces: packingPieces(partsByItem.get(item.id) ?? [], item.packing), settings: item.packing })))
  const [packingState, setPackingState] = useState<{ input: string; results: Record<string, { result?: PackingEstimate; error?: string }> }>({ input: '', results: {} })
  const estimates = packingState.input === packingJobs ? packingState.results : {}
  useEffect(() => {
    if (typeof Worker === 'undefined') return
    const worker = new Worker(new URL('../packing/worker.ts', import.meta.url), { type: 'module' })
    let active = true
    worker.onmessage = event => { if (active) setPackingState(state => ({ input: packingJobs, results: { ...(state.input === packingJobs ? state.results : {}), [event.data.id]: event.data } })) }
    worker.onerror = () => { if (active) setPackingState({ input: packingJobs, results: Object.fromEntries(JSON.parse(packingJobs).map((item: { id: string }) => [item.id, { error: 'Packing calculation unavailable.' }])) }) }
    worker.postMessage(JSON.parse(packingJobs))
    return () => { active = false; worker.terminate() }
  }, [packingJobs])
  const selectedItem = ownItems.find(item => item.id === detailId)
  const selectedParts = selectedItem ? partsByItem.get(selectedItem.id) ?? [] : []
  const term = query.trim().toLowerCase()
  const visibleItems = ownItems.filter(item => {
    const components = partsByItem.get(item.id) ?? []
    return (filter === 'all' || (filter === 'populated' ? components.length > 0 : components.length === 0)) &&
      [item.name, item.sku, item.description, ...components.flatMap(part => [part.name, part.sku, part.originalFilename])].some(value => value.toLowerCase().includes(term))
  }).sort((a, b) => {
    if (sort === 'updated') return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.name.localeCompare(b.name)
    if (sort === 'components') return (partsByItem.get(b.id)?.length ?? 0) - (partsByItem.get(a.id)?.length ?? 0) || a.name.localeCompare(b.name)
    return a.name.localeCompare(b.name, undefined, { numeric: true })
  })
  const visibleParts = selectedParts.filter(part => [part.name, part.sku, part.originalFilename].some(value => value.toLowerCase().includes(componentQuery.trim().toLowerCase())))

  function openItem(id: string) {
    onSelectItem(id)
    setDetailId(id)
    setComponentQuery('')
    setAdded(undefined)
  }

  return <main className="items-page">
    {selectedItem ? <>
      <button type="button" className="items-back" onClick={() => setDetailId(undefined)}><ArrowLeft size={16} /> All items</button>
      <header className="items-heading">
        <div><h2>{selectedItem.name || 'Untitled item'}</h2><p>{selectedItem.sku} <span aria-hidden="true">/</span> {selectedParts.length} components</p></div>
        <div className="items-actions">
          <button type="button" onClick={onOpenSheet}>Open sheet <ArrowRight size={16} /></button>
          <label className="file-button items-upload"><FileUp size={16} /> Upload components<input aria-label="Upload components" type="file" multiple accept=".nc,.tap,.gcode,.cnc,.dxf" onChange={event => {
            if (event.target.files?.length) onImportComponents(selectedItem.id, event.target.files)
            event.currentTarget.value = ''
          }} /></label>
        </div>
      </header>
      <section className="items-metadata" aria-label="Item details">
        <label>Item name<input value={selectedItem.name} onChange={event => onUpdateItem(selectedItem.id, { name: event.target.value })} /></label>
        <label>SKU<input value={selectedItem.sku} onChange={event => onUpdateItem(selectedItem.id, { sku: event.target.value.toUpperCase() })} /></label>
        <label>Description<textarea aria-label="Description" rows={2} value={selectedItem.description} onChange={event => onUpdateItem(selectedItem.id, { description: event.target.value })} /></label>
        <div className="items-dates"><span>Created {dateLabel(selectedItem.createdAt)}</span><span>Updated {dateLabel(selectedItem.updatedAt)}</span></div>
      </section>
      {selectedParts.length > 0 && <PackingPanel pieces={packingPieces(selectedParts, selectedItem.packing)} settings={selectedItem.packing} estimate={estimates[selectedItem.id]?.result} error={estimates[selectedItem.id]?.error} onChange={packing => onUpdateItem(selectedItem.id, { packing })} />}
      <div className="items-component-bar"><h3>Components <span>{selectedParts.length}</span></h3><label className="items-search"><Search size={17} /><input aria-label="Search components" placeholder="Search components" value={componentQuery} onChange={event => setComponentQuery(event.target.value)} /></label></div>
      {added && <p role="status" className="items-added">{added} added to the sheet.</p>}
      {visibleParts.length ? <div className="items-grid items-components">
        {visibleParts.map(part => <article key={part.id} className="items-component-card">
          <ItemPreview parts={[part]} label={`${part.name} toolpath`} />
          <div className="items-card-body"><h4>{part.name}</h4><span className="items-sku">{part.sku}</span><p>{part.width.toFixed(1)} x {part.height.toFixed(1)} mm</p><p className="items-filename">{part.originalFilename}{part.dxf ? ' + DXF' : ''}</p></div>
          <div className="items-card-footer"><button type="button" onClick={() => { onAddToSheet(part.id); setAdded(part.name) }}><Plus size={16} /> Add to sheet</button><button type="button" className="items-icon danger" aria-label={`Remove ${part.name}`} title={`Remove ${part.name}`} onClick={() => {
            if (window.confirm(`Remove "${part.name}" from this item? This cannot be undone.`)) onDeleteComponent(part.id)
          }}><Trash2 size={16} /></button></div>
        </article>)}
      </div> : <div className="items-empty"><Package size={32} /><h3>{selectedParts.length ? 'No matching components' : 'No components yet'}</h3>{componentQuery && <button type="button" onClick={() => setComponentQuery('')}>Clear search</button>}</div>}
    </> : <>
      <header className="items-heading"><div><h2>Items</h2><p>{ownItems.length} items <span aria-hidden="true">/</span> {ownItems.reduce((sum, item) => sum + (partsByItem.get(item.id)?.length ?? 0), 0)} components</p></div><button type="button" className="primary" onClick={() => openItem(onCreateItem())}><Plus size={17} /> New item</button></header>
      <div className="items-controls">
        <label className="items-search"><Search size={18} /><input aria-label="Search items" placeholder="Search items, SKUs or components" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="items-icon" type="button" title="Clear search" aria-label="Clear search" onClick={() => setQuery('')}><X size={16} /></button>}</label>
        <label>Show<select aria-label="Filter items" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All items</option><option value="populated">With components</option><option value="empty">Empty items</option></select></label>
        <label>Sort by<select aria-label="Sort items" value={sort} onChange={event => setSort(event.target.value)}><option value="name">Name A-Z</option><option value="updated">Recently updated</option><option value="components">Most components</option></select></label>
      </div>
      <p className="items-result-count" role="status">{visibleItems.length} of {ownItems.length} items</p>
      {visibleItems.length ? <div className="items-grid">
        {visibleItems.map(item => {
          const components = partsByItem.get(item.id) ?? []
          return <button type="button" className="items-grid-card" key={item.id} aria-label={`Open ${item.name || 'Untitled item'}`} onClick={() => openItem(item.id)}>
            <ItemPreview parts={components} label={`${item.name} components`} />
            <div className="items-card-body"><div className="items-card-title"><h3>{item.name || 'Untitled item'}</h3><ArrowRight size={17} /></div><span className="items-sku">{item.sku}</span><p className="items-description">{item.description || 'No description'}</p>{components.length > 0 && <span className="items-box-estimate">{estimates[item.id]?.result?.plans[0] ? `Box estimate: ${boxSize(estimates[item.id].result!.plans[0].internal)}` : estimates[item.id]?.error || (estimates[item.id]?.result?.errors.length ? 'Box estimate: review dimensions' : 'Calculating box...')}</span>}</div>
            <div className="items-card-footer"><span className={`items-count ${components.length ? '' : 'is-empty'}`}><Package size={14} />{components.length} component{components.length === 1 ? '' : 's'}</span><small>Updated {dateLabel(item.updatedAt)}</small></div>
          </button>
        })}
      </div> : <div className="items-empty"><Package size={36} /><h3>{ownItems.length ? 'No matching items' : 'No items yet'}</h3>{ownItems.length > 0 && <button type="button" onClick={() => { setQuery(''); setFilter('all') }}>Clear filters</button>}</div>}
    </>}
  </main>
}
