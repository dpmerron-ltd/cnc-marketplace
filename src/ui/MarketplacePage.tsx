import { useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, FileUp, Package, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import type { MarketplaceItem } from '../models/Item'
import { itemImageUrl, type ItemImage } from '../models/ItemImage'
import { ItemImageEditor } from './ItemImageEditor'
import type { ComponentSummary, Part } from '../models/Part'
import { ItemPreview } from './ItemPreview'
import { PackingPanel } from './PackingPanel'
import { boxSize } from '../packing/format'
import { packingPieces } from '../packing/packing'
import { useBoxStock } from '../storage/useBoxStock'
import { usePackingEstimates } from '../packing/usePackingEstimates'
import './MarketplacePage.css'

interface MarketplacePageProps {
  items: MarketplaceItem[]
  parts: Part[]
  componentIndex?: ComponentSummary[]
  componentLoads?: Record<string, { state: 'idle' | 'loading' | 'loaded' | 'error'; error?: string }>
  onLoadComponents?: (itemId: string) => Promise<unknown>
  currentUserId?: string
  onCreateItem: () => string
  onSelectItem: (itemId: string) => void
  onUpdateItem: (itemId: string, patch: Partial<MarketplaceItem>) => void
  onSaveImage: (itemId: string, image: ItemImage | null) => Promise<void>
  onImportComponents: (itemId: string, files: FileList) => void
  onDeleteComponent: (partId: string) => void
  onAddToSheet: (partId: string) => void
  onAddItemToSheet: (itemId: string) => number | Promise<number>
  onOpenSheet: () => void
}

function dateLabel(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function MarketplacePage({ items, parts, componentIndex, componentLoads, onLoadComponents, currentUserId, onCreateItem, onSelectItem, onUpdateItem, onSaveImage, onImportComponents, onDeleteComponent, onAddToSheet, onAddItemToSheet, onOpenSheet }: MarketplacePageProps) {
  const [detailId, setDetailId] = useState<string>()
  const [query, setQuery] = useState('')
  const [componentQuery, setComponentQuery] = useState('')
  const [sort, setSort] = useState('name')
  const [filter, setFilter] = useState('all')
  const [added, setAdded] = useState<string>()
  const [addError, setAddError] = useState('')
  const [adding, setAdding] = useState(false)
  const sharedItems = useMemo(() => currentUserId ? items : [], [items, currentUserId])
  const partsByItem = useMemo(() => {
    const map = new Map<string, ComponentSummary[]>()
    for (const part of componentIndex ?? parts) {
      if (!part.itemId || !currentUserId) continue
      const group = map.get(part.itemId) ?? []
      group.push(part)
      map.set(part.itemId, group)
    }
    return map
  }, [componentIndex, parts, currentUserId])
  const stock = useBoxStock(currentUserId)
  const packingJobs = stock.boxes ? JSON.stringify(sharedItems.map(item => ({ id: item.id, pieces: packingPieces(partsByItem.get(item.id) ?? [], item.packing), settings: item.packing, boxes: stock.boxes }))) : undefined
  const estimates = usePackingEstimates(packingJobs)
  const selectedItem = sharedItems.find(item => item.id === detailId)
  const selectedParts = selectedItem ? parts.filter(part => part.itemId === selectedItem.id) : []
  const selectedCount = selectedItem ? partsByItem.get(selectedItem.id)?.length ?? 0 : 0
  const componentLoad = selectedItem ? componentLoads?.[selectedItem.id] : undefined
  const componentsReady = !componentLoad || componentLoad.state === 'loaded'
  const term = query.trim().toLowerCase()
  const visibleItems = sharedItems.filter(item => {
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
    setAddError('')
    void onLoadComponents?.(id).catch(() => {})
  }

  return <main className="items-page">
    {selectedItem ? <>
      <button type="button" className="items-back" onClick={() => setDetailId(undefined)}><ArrowLeft size={16} /> All items</button>
      <header className="items-heading">
        <div><h2>{selectedItem.name || 'Untitled item'}</h2><p>{selectedItem.sku} <span aria-hidden="true">/</span> {selectedCount} components</p></div>
        <div className="items-actions">
          <button type="button" disabled={adding || !componentsReady || !selectedParts.length} onClick={async () => {
            setAddError(''); setAdding(true)
            try { const count = await onAddItemToSheet(selectedItem.id); setAdded(`${count} components from ${selectedItem.name}`) }
            catch (error) { setAdded(undefined); setAddError(error instanceof Error ? error.message : 'The item could not be added.') }
            finally { setAdding(false) }
          }}><Plus size={16} /> {adding ? 'Adding components...' : 'Add all to sheet'}</button>
          <button type="button" onClick={onOpenSheet}>Open sheet <ArrowRight size={16} /></button>
          <label className="file-button items-upload"><FileUp size={16} /> Upload components<input aria-label="Upload components" disabled={!componentsReady} type="file" multiple accept=".nc,.tap,.gcode,.cnc,.dxf" onChange={event => {
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
      <ItemImageEditor key={`${currentUserId}:${selectedItem.id}`} image={selectedItem.image} name={selectedItem.name} onSave={image => onSaveImage(selectedItem.id, image)} />
      {componentsReady && selectedParts.length > 0 && <PackingPanel pieces={packingPieces(selectedParts, selectedItem.packing)} settings={selectedItem.packing} estimate={estimates[selectedItem.id]?.result} error={stock.error || estimates[selectedItem.id]?.error} onChange={packing => onUpdateItem(selectedItem.id, { packing })} />}
      <div className="items-component-bar"><h3>Components <span>{selectedCount}</span></h3><label className="items-search"><Search size={17} /><input aria-label="Search components" placeholder="Search components" value={componentQuery} onChange={event => setComponentQuery(event.target.value)} /></label></div>
      {added && <p role="status" className="items-added">{added} added to the sheet.</p>}
      {addError && <p role="alert">{addError}</p>}
      {!componentsReady ? <div className="items-empty">{componentLoad?.error ? <><p role="alert">{componentLoad.error}</p><button type="button" onClick={() => void onLoadComponents?.(selectedItem.id).catch(() => {})}><RefreshCw size={16} /> Retry components</button></> : <p role="status">Loading components...</p>}</div> : visibleParts.length ? <div className="items-grid items-components">
        {visibleParts.map(part => <article key={part.id} className="items-component-card">
          <ItemPreview parts={[part]} label={`${part.name} toolpath`} />
          <div className="items-card-body"><h4>{part.name}</h4><span className="items-sku">{part.sku}</span><p>{part.width.toFixed(1)} x {part.height.toFixed(1)} mm</p><p className="items-filename">{part.originalFilename}{part.dxf ? ' + DXF' : ''}</p></div>
          <div className="items-card-footer"><button type="button" onClick={() => { onAddToSheet(part.id); setAdded(part.name) }}><Plus size={16} /> Add to sheet</button><button type="button" className="items-icon danger" aria-label={`Remove ${part.name}`} title={`Remove ${part.name}`} onClick={() => {
            if (window.confirm(`Remove "${part.name}" from this item? This cannot be undone.`)) onDeleteComponent(part.id)
          }}><Trash2 size={16} /></button></div>
        </article>)}
      </div> : <div className="items-empty"><Package size={32} /><h3>{selectedParts.length ? 'No matching components' : 'No components yet'}</h3>{componentQuery && <button type="button" onClick={() => setComponentQuery('')}>Clear search</button>}</div>}
    </> : <>
      <header className="items-heading"><div><h2>Items</h2><p>{sharedItems.length} items <span aria-hidden="true">/</span> {sharedItems.reduce((sum, item) => sum + (partsByItem.get(item.id)?.length ?? 0), 0)} components</p></div><button type="button" className="primary" onClick={() => openItem(onCreateItem())}><Plus size={17} /> New item</button></header>
      <div className="items-controls">
        <label className="items-search"><Search size={18} /><input aria-label="Search items" placeholder="Search items, SKUs or components" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="items-icon" type="button" title="Clear search" aria-label="Clear search" onClick={() => setQuery('')}><X size={16} /></button>}</label>
        <label>Show<select aria-label="Filter items" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All items</option><option value="populated">With components</option><option value="empty">Empty items</option></select></label>
        <label>Sort by<select aria-label="Sort items" value={sort} onChange={event => setSort(event.target.value)}><option value="name">Name A-Z</option><option value="updated">Recently updated</option><option value="components">Most components</option></select></label>
      </div>
      <p className="items-result-count" role="status">{visibleItems.length} of {sharedItems.length} items</p>
      {stock.error && <p role="alert">Box stock: {stock.error} <button type="button" onClick={stock.reload}>Retry box stock</button></p>}
      {visibleItems.length ? <div className="items-grid">
        {visibleItems.map(item => {
          const components = partsByItem.get(item.id) ?? []
          return <button type="button" className="items-grid-card" key={item.id} aria-label={`Open ${item.name || 'Untitled item'}`} onClick={() => openItem(item.id)}>
            {item.image ? <div className="items-preview item-photo"><img loading="lazy" src={itemImageUrl(item.image)} alt={item.name || 'Item'} /></div> : <ItemPreview parts={parts.filter(part => part.itemId === item.id)} label={`${item.name} components`} emptyLabel={components.length ? 'Component preview' : 'No components'} />}
            <div className="items-card-body"><div className="items-card-title"><h3>{item.name || 'Untitled item'}</h3><ArrowRight size={17} /></div><span className="items-sku">{item.sku}</span><p className="items-description">{item.description || 'No description'}</p>{estimates[item.id] && <span className="items-box-estimate">{estimates[item.id]?.result?.boxes[0] ? `${estimates[item.id].result!.boxes.length} box${estimates[item.id].result!.boxes.length === 1 ? '' : 'es'}: ${estimates[item.id].result!.boxes.map(box => boxSize(box.internal)).join(' + ')}` : estimates[item.id]?.error || 'Box estimate: review dimensions'}</span>}</div>
            <div className="items-card-footer"><span className={`items-count ${components.length ? '' : 'is-empty'}`}><Package size={14} />{components.length} component{components.length === 1 ? '' : 's'}</span><small>Updated {dateLabel(item.updatedAt)}</small></div>
          </button>
        })}
      </div> : <div className="items-empty"><Package size={36} /><h3>{sharedItems.length ? 'No matching items' : 'No items yet'}</h3>{sharedItems.length > 0 && <button type="button" onClick={() => { setQuery(''); setFilter('all') }}>Clear filters</button>}</div>}
    </>}
  </main>
}
