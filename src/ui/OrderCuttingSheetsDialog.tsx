import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { materialProfiles } from '../cam/materialProfiles'
import { sheetNeedsExport, type ProductionJob } from '../jobs/production'
import { sheetMaterial, stockLabel } from '../models/stockMaterial'
import { orderCuttingSheets, type CuttingOrder } from '../orders/cuttingSheets'
import './OrderCuttingSheetsDialog.css'

export function OrderCuttingSheetsDialog({ order, jobs, onOpen, onClose }: {
  order: CuttingOrder
  jobs: ProductionJob[]
  onOpen: (jobId: string, sheetIndex?: number) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [showCut, setShowCut] = useState(false)
  useEffect(() => { dialog.current?.showModal() }, [])
  const { sheets, pending } = orderCuttingSheets(jobs, order)
  const waiting = sheets.filter(sheet => sheet.stage === 'waiting').length
  const cutting = sheets.filter(sheet => sheet.stage === 'cutting').length
  const cut = sheets.filter(sheet => sheet.stage === 'cut').length
  const pendingCount = pending.reduce((sum, entry) => sum + entry.count, 0)
  function open(jobId: string, index?: number) { onClose(); onOpen(jobId, index) }

  return <dialog ref={dialog} className="order-cutting-dialog" aria-labelledby="order-cutting-title" onCancel={onClose}>
    <header className="order-cutting-heading"><div><h2 id="order-cutting-title">Cutting sheets for {order.name}</h2><p>Sheets in your cutting jobs containing parts for this order.</p></div><button type="button" className="icon-button" aria-label="Close cutting sheets" onClick={onClose}><X size={20} /></button></header>
    <div className="order-cutting-totals" aria-label="Sheet progress"><span><strong>{waiting}</strong> waiting</span><span><strong>{cutting}</strong> cutting</span><span><strong>{cut}</strong> cut</span>{pendingCount > 0 && <span><strong>{pendingCount}</strong> {pendingCount === 1 ? 'part' : 'parts'} awaiting allocation</span>}</div>
    {!sheets.length && !pending.length ? <p>No sheets are planned for this order in your cutting jobs yet. Use Add to sheet on the Orders page to plan its parts.</p> : <>
      <p className="order-cutting-summary">{waiting + cutting ? `${waiting + cutting} ${waiting + cutting === 1 ? 'sheet still needs' : 'sheets still need'} cutting.` : pendingCount ? 'Allocate the remaining parts to sheets before cutting.' : 'All planned sheets are cut.'}</p>
      {pending.length > 0 && <section className="order-cutting-pending" aria-label="Parts awaiting allocation"><h3>Parts awaiting allocation</h3>{pending.map(({ job, count }) => <div key={job.id}><span>{job.name} · {count} {count === 1 ? 'part' : 'parts'} without a sheet</span><button type="button" onClick={() => open(job.id)}>Open job to allocate</button></div>)}</section>}
      {cut > 0 && <label className="order-cutting-toggle"><input type="checkbox" checked={showCut} onChange={event => setShowCut(event.target.checked)} /> Show cut sheets ({cut})</label>}
      <div className="order-cutting-list">{sheets.filter(sheet => showCut || sheet.stage !== 'cut').map(({ job, index, stage, partCount, totalParts }) => {
        const setup = sheetMaterial(job.sheet, index)
        const dirty = sheetNeedsExport(job, index)
        const state = job.sheets[index]
        const status = stage === 'cut' ? 'Cut' : stage === 'cutting' ? 'Cutting' : dirty ? 'Waiting · needs export' : 'Waiting · ready to cut'
        return <article className="order-cutting-sheet" key={`${job.id}:${index}`} aria-label={`${job.name}, Sheet ${index + 1}`}>
          <div className="order-cutting-heading"><div><p className="order-cutting-job">{job.name}{job.revision > 0 ? ` · revision ${job.revision}` : ''}</p><h3>Sheet {index + 1}</h3></div><span className={`order-cutting-stage stage-${stage}`}>{status}</span></div>
          <p><strong>{setup.stockMaterial ? stockLabel(setup.stockMaterial) : setup.material || 'Material not specified'}</strong> · {job.sheet.width} × {job.sheet.height} mm</p>
          <p>Cutting preset: {materialProfiles.find(profile => profile.id === setup.materialProfile)?.label ?? 'Original NC'}</p>
          <p>{partCount} {partCount === 1 ? 'part' : 'parts'} for {order.name}{totalParts > partCount ? ` · ${totalParts} parts on this sheet` : ''}</p>
          {totalParts > partCount && <p className="order-cutting-shared">Shared sheet: includes {totalParts - partCount} other {totalParts - partCount === 1 ? 'part' : 'parts'}. Cut the complete sheet.</p>}
          <div className="order-cutting-actions">{!job.archived && <button type="button" onClick={() => open(job.id, index)}>Open sheet</button>}{state?.runId && !dirty && <a href={`#machine/${state.runId}?sheet=${index + 1}`} onClick={onClose}>Cutting file</a>}{dirty && stage === 'waiting' && <span>Open the sheet to review and export its latest layout.</span>}</div>
        </article>
      })}</div>
    </>}
  </dialog>
}
