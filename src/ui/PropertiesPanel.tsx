import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import type { Rotation } from '../models/geometry'
import { partNumberText } from '../labels/partLabels'
import { instanceBounds } from '../gcode/transform'

interface PropertiesPanelProps {
  part?: Part
  instance?: PartInstance
  onUpdate: (patch: Partial<PartInstance>) => void
  onDuplicate: () => void
  onDelete: () => void
}

export function PropertiesPanel({ part, instance, onUpdate, onDuplicate, onDelete }: PropertiesPanelProps) {
  const bounds = part && instance ? instanceBounds(part, instance) : undefined
  return (
    <aside className="panel properties">
      <h2>Selection</h2>
      {!part || !instance ? (
        <p className="muted">Select a placed part to edit its exact position, rotation and lock state.</p>
      ) : (
        <div className="property-grid">
          <strong>{partNumberText(instance.partNumber!)}: {part.name}</strong>
          <label>
            Sheet
            <input type="number" min={1} value={instance.sheetIndex + 1} onChange={(event) => onUpdate({ sheetIndex: Math.max(0, Number(event.target.value) - 1) })} />
          </label>
          <label>
            X
            <input type="number" value={instance.x} onChange={(event) => onUpdate({ x: Number(event.target.value) })} />
          </label>
          <label>
            Y
            <input type="number" value={instance.y} onChange={(event) => onUpdate({ y: Number(event.target.value) })} />
          </label>
          <label>
            Rotation
            <select value={instance.rotation} onChange={(event) => onUpdate({ rotation: Number(event.target.value) as Rotation })}>
              {![0, 90, 180, 270].includes(instance.rotation) && <option value={instance.rotation}>{Number(instance.rotation.toFixed(3))} deg</option>}
              <option value={0}>0 deg</option>
              <option value={90}>90 deg</option>
              <option value={180}>180 deg</option>
              <option value={270}>270 deg</option>
            </select>
          </label>
          <label>
            Width
            <input readOnly value={(bounds!.maxX - bounds!.minX).toFixed(2)} />
          </label>
          <label>
            Height
            <input readOnly value={(bounds!.maxY - bounds!.minY).toFixed(2)} />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={instance.locked} onChange={(event) => onUpdate({ locked: event.target.checked })} />
            Locked
          </label>
          <div className="button-row">
            <button type="button" onClick={onDuplicate}>Duplicate</button>
            <button type="button" className="danger" onClick={onDelete}>Delete</button>
          </div>
        </div>
      )}
    </aside>
  )
}
