import type { Part } from '../models/Part'

interface PartLibraryProps {
  parts: Part[]
  title?: string
  emptyText?: string
  selectedPartId?: string
  onImport: (files: FileList) => void
  onAdd: (partId: string) => void
  onSelect: (partId: string) => void
}

export function PartLibrary({ parts, title = 'Components', emptyText = 'Select an item or upload components to place on the sheet.', selectedPartId, onImport, onAdd, onSelect }: PartLibraryProps) {
  return (
    <aside className="panel library">
      <div className="panel-header">
        <h2>{title}</h2>
        <label className="file-button">
          Import
          <input
            type="file"
            multiple
            accept=".nc,.tap,.gcode,.cnc,.dxf"
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
