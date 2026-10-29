import { useState } from 'react'
import type { ComponentSummary } from '../models/Part'
import { materialProfiles } from '../cam/materialProfiles'
import { cutSideLabel, sheetCutSide } from '../models/cutSide'
import { sheetIndices, sheetNeedsExport, type ProductionJob, type SheetStage } from '../jobs/production'
import './CuttingJobsPage.css'

export function CuttingJobsPage({ jobs, components, onOpen, onNew, onStage, onLabels, onReplan }: {
  jobs: ProductionJob[]; components: ComponentSummary[]; onOpen: (id: string) => void; onNew: () => void
  onStage: (id: string, index: number, stage: SheetStage) => Promise<void>
  onLabels: (id: string, index: number) => Promise<void>; onReplan: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [showCut, setShowCut] = useState(false)
  async function act(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await action() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  return <main className="cutting-jobs"><div className="cutting-jobs-heading"><div><h2>Cutting Jobs</h2><p>Plan orders, fill waiting sheets and track each sheet through cutting.</p></div><div className="button-row"><button type="button" disabled={busy} onClick={onNew}>New job</button><button type="button" disabled={busy} onClick={() => void act(onReplan)}>{busy ? 'Working…' : 'Re-plan waiting sheets'}</button><a href="#machine/history">Previous exports</a></div></div>
    <p>Re-planning combines compatible waiting jobs by material and thickness. Sheets cutting or already cut stay fixed. Review and export changed layouts before cutting.</p>
    <label><input type="checkbox" checked={showCut} onChange={e => setShowCut(e.target.checked)} /> Show cut sheets</label>
    {error && <p role="alert">{error}</p>}
    {jobs.filter(job => !job.archived).map(job => {
      const indices = sheetIndices(job.sheet).filter(index => showCut || job.sheets[index]?.stage !== 'cut')
      if (!indices.length && job.sheet.instances.length) return null
      return <section className="cutting-job" key={job.id}><div className="cutting-jobs-heading"><div><h3>{job.name}{job.revision ? ` · revision ${job.revision}` : ''}</h3><p>{materialProfiles.find(p => p.id === job.sheet.materialProfile)?.label ?? 'Original NC'} · {job.sheet.material || 'Material not specified'} · {job.sheet.width} × {job.sheet.height} mm</p></div><button type="button" disabled={busy} onClick={() => onOpen(job.id)}>Open job</button></div>
        {!indices.length ? <p>No parts yet. Open this job to add order or re-cut parts.</p> : <table><thead><tr><th>Sheet</th><th>Parts</th><th>Face up</th><th>Progress</th><th>Actions</th></tr></thead><tbody>{indices.map(index => {
          const state = job.sheets[index], stage = state?.stage ?? 'waiting', dirty = sheetNeedsExport(job, index)
          return <tr key={index}><td>Sheet {index + 1}</td><td>{job.sheet.instances.filter(i => i.sheetIndex === index).length}</td><td>{cutSideLabel(sheetCutSide(components, job.sheet, index))}</td><td>{stage === 'cut' ? 'Cut' : stage === 'cutting' ? 'Cutting' : dirty ? 'Waiting · needs export' : 'Waiting · ready'}</td><td><div className="button-row"><button type="button" disabled={busy} onClick={() => void act(() => onLabels(job.id, index))}>Print labels</button>{state?.runId && !dirty && <a href={`#machine/${state.runId}?sheet=${index + 1}`}>Cutting file</a>}{stage === 'waiting' && <button type="button" disabled={busy || dirty} onClick={() => void act(() => onStage(job.id, index, 'cutting'))}>Start cutting</button>}{stage !== 'cut' && <button type="button" disabled={busy || dirty} onClick={() => void act(() => onStage(job.id, index, 'cut'))}>Mark cut</button>}</div></td></tr>
        })}</tbody></table>}
      </section>
    })}
  </main>
}
