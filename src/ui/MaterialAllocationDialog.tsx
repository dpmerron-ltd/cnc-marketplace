import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'
import { allocateMaterials } from '../nesting/allocateMaterials'
import { sheetMaterial, stockLabel } from '../models/stockMaterial'
import { cutSideLabel, sheetCutSide } from '../models/cutSide'
import { materialProfiles } from '../cam/materialProfiles'

export function MaterialAllocationDialog({ name, parts, sheet, additions, startIndex, onApply, onCancel }: {
  name: string; parts: Part[]; sheet: Sheet; additions: PartInstance[]; startIndex: number; onApply: (sheet: Sheet) => void; onCancel: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current!
    // Orders already has a modal open. Join the browser's top layer so this
    // confirmation stays interactive above it, including keyboard navigation.
    element.showModal()
    element.querySelector<HTMLInputElement>('input:checked')?.focus()
    return () => element.close()
  }, [])
  const [matching, setMatching] = useState(false)
  const result = useMemo(() => { try { return { sheet: allocateMaterials(parts, sheet, additions, startIndex, matching), error: '' } } catch(e) { return { error: (e as Error).message } } }, [parts, sheet, additions, startIndex, matching])
  const ids = new Set(additions.map(i => i.id))
  const placed = result.sheet?.instances.filter(i => ids.has(i.id)) ?? []
  const pending = result.sheet?.pendingParts?.filter(i => ids.has(i.id)) ?? []
  return <dialog ref={dialog} onCancel={event => {
    event.preventDefault()
    onCancel()
  }} className="export-modal material-allocation" aria-label="Allocate item materials"><h2>Add {name}</h2>
    <p>Review the stock and cutting preset for each sheet. Existing placements stay fixed; new sheets are created where needed.</p>
    <label><input type="radio" name="allocation" checked={!matching} onChange={() => setMatching(false)} /> Allocate every part to compatible waiting sheets in this job</label>
    <label><input type="radio" name="allocation" checked={matching} onChange={() => setMatching(true)} /> Add matching parts to this sheet; keep the rest awaiting allocation</label>
    {result.error && <p role="alert">{result.error}</p>}
    {result.sheet && <table><thead><tr><th>Sheet</th><th>New parts</th><th>Stock</th><th>Face up</th><th>Cutting preset</th></tr></thead><tbody>{[...new Set(placed.map(i => i.sheetIndex))].map(index => {
      const setup = sheetMaterial(result.sheet!, index)
      return <tr key={index}><td>{index + 1}</td><td>{placed.filter(i => i.sheetIndex === index).length}</td><td>{setup.stockMaterial ? stockLabel(setup.stockMaterial) : setup.material || 'Not specified'}</td><td>{cutSideLabel(sheetCutSide(parts, result.sheet!, index))}</td><td>{materialProfiles.find(p => p.id === setup.materialProfile)?.label ?? 'Original NC'}</td></tr>
    })}</tbody></table>}
    <p>{placed.length} parts allocated · {pending.length} awaiting allocation · {additions.length} total</p>
    {pending.length > 0 && <p>The remaining parts will stay visible in this job until allocated. They will not be included in a cutting export yet.</p>}
    <div className="button-row"><button type="button" onClick={onCancel}>Cancel</button><button type="button" disabled={!result.sheet} onClick={() => result.sheet && onApply(result.sheet)}>Add parts</button></div>
  </dialog>
}
