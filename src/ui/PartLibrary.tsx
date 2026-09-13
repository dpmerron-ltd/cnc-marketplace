import type { MarketplaceItem } from '../models/Item'
import type { Part } from '../models/Part'

interface PartLibraryProps {
  items?: MarketplaceItem[]
  parts: Part[]
  title?: string
  emptyText?: string
  selectedItemId?: string
  selectedPartId?: string
  canImport?: boolean
  onSelectItem?: (itemId: string) => void
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
  onImport,
  onAdd,
  onSelect,
}: PartLibraryProps) {
  return (
    <aside className="panel library">
      {items.length > 0 && onSelectItem && (
        <div className="library-items">
          <h2>Items</h2>
          <div className="library-item-list">
            {items.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`library-item ${selectedItemId === item.id ? 'selected' : ''}`}
                onClick={() => onSelectItem(item.id)}
              >
                <strong>{item.name}</strong>
                <small>{item.sku}</small>
              </button>
            ))}
          </div>
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
          <button
            type="button"
            key={part.id}
            className={`part-row ${selectedPartId === part.id ? 'selected' : ''}`}
            draggable
            onDragStart={(event) => event.dataTransfer.setData('text/part-id', part.id)}
            onClick={() => onSelect(part.id)}
            onDoubleClick={() => onAdd(part.id)}
          >
            <span>{part.name}</span>
            <small>{part.sku}</small>
            <small>
              {part.width.toFixed(1)} x {part.height.toFixed(1)} mm
              {part.dxf ? ' + DXF' : ''}
            </small>
            <span className="row-actions">
              <span onClick={(event) => event.stopPropagation()}>
                <button type="button" onClick={() => onAdd(part.id)}>
                  Add
                </button>
              </span>
            </span>
          </button>
        ))}
      </div>
    </aside>
  )
}
