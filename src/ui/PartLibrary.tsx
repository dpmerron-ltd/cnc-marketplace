import type { MarketplaceItem } from '../models/Item'
import type { Part } from '../models/Part'
import { LayoutGrid } from 'lucide-react'

interface PartLibraryProps {
  items?: MarketplaceItem[]
  parts: Part[]
  title?: string
  emptyText?: string
  selectedItemId?: string
  selectedPartId?: string
  canImport?: boolean
  onSelectItem?: (itemId: string) => void
  onManageItems?: () => void
  onImport: (files: FileList) => void
  onAdd: (partId: string) => void
  onSelect: (partId: string) => void
}

export function PartLibrary({
  items = [],
  parts,
  title = 'Components',
  emptyText = 'Select an item or upload components to place on the sheet.',
  selectedItemId,
  selectedPartId,
  canImport = true,
  onSelectItem,
  onManageItems,
  onImport,
  onAdd,
  onSelect,
}: PartLibraryProps) {
  return (
    <aside className="panel library">
      {items.length > 0 && onSelectItem && (
        <div className="library-items">
          <div className="panel-header"><h2>Item</h2>{onManageItems && <button type="button" aria-label="Manage items" title="Manage items" onClick={onManageItems}><LayoutGrid size={17} /></button>}</div>
          <select aria-label="Sheet item" value={selectedItemId ?? ''} onChange={event => onSelectItem(event.target.value)} style={{ width: '100%' }}><option value="" disabled>Select an item</option>{items.map(item => <option key={item.id} value={item.id}>{item.name} ({item.sku})</option>)}</select>
        </div>
      )}
      <div className="panel-header">
        <h2>{title}</h2>
        <label className={`file-button ${canImport ? '' : 'disabled-file'}`}>
          Import
          <input
            type="file"
            multiple
            accept=".nc,.tap,.gcode,.cnc,.dxf"
            disabled={!canImport}
            onChange={(event) => {
              if (event.target.files) onImport(event.target.files)
              event.currentTarget.value = ''
            }}
          />
        </label>
      </div>

      <div className="part-list">
        {parts.length === 0 && <p className="muted">{emptyText}</p>}
        {parts.map((part) => (
          <div
            key={part.id}
            className={`part-row ${selectedPartId === part.id ? 'selected' : ''}`}
            draggable
            onDragStart={(event) => event.dataTransfer.setData('text/part-id', part.id)}
            onClick={() => onSelect(part.id)}
            onDoubleClick={() => onAdd(part.id)}
            role="button"
            tabIndex={0}
            onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onSelect(part.id) } }}
          >
            <span>{part.name}</span>
            <small>{part.sku}</small>
            <small>
              {part.width.toFixed(1)} x {part.height.toFixed(1)} mm
              {part.dxf ? ' + DXF' : ''}
            </small>
            <span className="row-actions">
              <span onClick={(event) => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
                <button type="button" onClick={() => onAdd(part.id)}>
                  Add
                </button>
              </span>
            </span>
          </div>
        ))}
      </div>
    </aside>
  )
}
