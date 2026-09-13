import type { MarketplaceItem } from '../models/Item'
import type { Part } from '../models/Part'

interface MarketplacePageProps {
  items: MarketplaceItem[]
  parts: Part[]
  selectedItemId?: string
  currentUserId?: string
  onCreateItem: () => void
  onSelectItem: (itemId: string) => void
  onUpdateItem: (itemId: string, patch: Partial<MarketplaceItem>) => void
  onImportComponents: (itemId: string, files: FileList) => void
  onDeleteComponent: (partId: string) => void
  onAddToSheet: (partId: string) => void
  onOpenSheet: () => void
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export function MarketplacePage({
  items,
  parts,
  selectedItemId,
  currentUserId,
  onCreateItem,
  onSelectItem,
  onUpdateItem,
  onImportComponents,
  onDeleteComponent,
  onAddToSheet,
  onOpenSheet,
}: MarketplacePageProps) {
  const selectedItem = items.find((item) => item.id === selectedItemId) ?? items[0]
  const selectedParts = selectedItem ? parts.filter((part) => part.itemId === selectedItem.id) : []
  const canEditSelectedItem = Boolean(selectedItem && (!selectedItem.ownerId || selectedItem.ownerId === currentUserId))

  return (
    <section className="marketplace-page">
      <aside className="panel item-browser">
        <div className="panel-header">
          <h2>Items</h2>
          <button type="button" onClick={onCreateItem}>New Item</button>
        </div>
        <div className="item-list">
          {items.length === 0 && <p className="muted">Create an item, then upload the CNC components that make it up.</p>}
          {items.map((item) => {
            const count = parts.filter((part) => part.itemId === item.id).length
            return (
              <button
                type="button"
                key={item.id}
                className={`item-card ${selectedItem?.id === item.id ? 'selected' : ''}`}
                onClick={() => onSelectItem(item.id)}
              >
                <strong>{item.name}</strong>
                <small>{item.sku}</small>
                <small>Uploaded by {item.uploadedBy || 'Unknown uploader'}</small>
                <small>{formatDateTime(item.createdAt)}</small>
                <small>{count} component{count === 1 ? '' : 's'}</small>
                {item.description && <span>{item.description}</span>}
              </button>
            )
          })}
        </div>
      </aside>

      <main className="panel item-detail">
        {!selectedItem ? (
          <div className="empty-state">
            <h2>Marketplace</h2>
            <p className="muted">Items group reusable G-code components. Select an item to manage its files.</p>
          </div>
        ) : (
          <>
            <div className="item-meta">
              <span>Uploaded by {selectedItem.uploadedBy || 'Unknown uploader'}</span>
              <span>{formatDateTime(selectedItem.createdAt)}</span>
            </div>
            <div className="item-edit">
              <label>
                Item name
                <input disabled={!canEditSelectedItem} value={selectedItem.name} onChange={(event) => onUpdateItem(selectedItem.id, { name: event.target.value })} />
              </label>
              <label>
                SKU
                <input disabled={!canEditSelectedItem} value={selectedItem.sku} onChange={(event) => onUpdateItem(selectedItem.id, { sku: event.target.value.toUpperCase() })} />
              </label>
              <label>
                Description
                <textarea disabled={!canEditSelectedItem} value={selectedItem.description} onChange={(event) => onUpdateItem(selectedItem.id, { description: event.target.value })} />
              </label>
              <label className={`file-button upload-components ${canEditSelectedItem ? '' : 'disabled-file'}`}>
                Upload Components
                <input
                  type="file"
                  multiple
                  accept=".nc,.tap,.gcode,.cnc,.dxf"
                  disabled={!canEditSelectedItem}
                  onChange={(event) => {
                    if (event.target.files) onImportComponents(selectedItem.id, event.target.files)
                    event.currentTarget.value = ''
                  }}
                />
              </label>
            </div>

            <div className="component-table">
              <div className="component-table-head">
                <h2>Components</h2>
                <button type="button" onClick={onOpenSheet}>Open Sheet</button>
              </div>
              {!canEditSelectedItem && <p className="muted">Shared item. You can add components to sheets; only the owner can edit the item.</p>}
              {selectedParts.length === 0 ? (
                <p className="muted">Upload one or more pre-generated Estlcam files for this item.</p>
              ) : (
                selectedParts.map((part) => (
                  <div className="component-row" key={part.id}>
                    <div>
                      <strong>{part.name}</strong>
                      <small>{part.sku}</small>
                      <small>
                        {part.width.toFixed(1)} x {part.height.toFixed(1)} mm from {part.originalFilename}
                        {part.dxf ? ' + DXF' : ''}
                      </small>
                    </div>
                    <button type="button" onClick={() => onAddToSheet(part.id)}>Add to Sheet</button>
                    <button type="button" className="danger" disabled={!canEditSelectedItem} onClick={() => onDeleteComponent(part.id)}>Remove</button>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </main>
    </section>
  )
}
