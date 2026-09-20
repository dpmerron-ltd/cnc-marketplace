import { Check, CircleAlert, LoaderCircle, RotateCw } from 'lucide-react'
import type { ComponentSaveJob } from './useComponentSaveQueue'
import './ComponentSaveQueue.css'

export function ComponentSaveQueue({ jobs, onRetry, onClear }: { jobs: ComponentSaveJob[]; onRetry: (id: string) => void; onClear: () => void }) {
  if (!jobs.length) return null
  const failed = jobs.filter(job => job.status === 'failed').length
  const saved = jobs.filter(job => job.status === 'saved').length
  return <section className="component-save-queue" aria-label="Component saves">
    <div className="component-save-heading"><strong>Component saves</strong><span role="status">{saved} saved / {jobs.length - saved - failed} pending{failed ? ` / ${failed} failed` : ''}</span>{saved > 0 && <button type="button" onClick={onClear}>Clear saved</button>}</div>
    <ul>{jobs.map(job => <li key={job.id}>
      <span className="component-save-name">{job.filename}<small>{job.itemName}</small>{job.error && <span role="alert">{job.error}</span>}</span>
      <span className="component-save-state">{job.status === 'saved' ? <Check size={16} /> : job.status === 'failed' ? <CircleAlert size={16} /> : <LoaderCircle size={16} />}{job.status === 'saved' ? 'Saved' : job.status === 'failed' ? 'Failed' : job.status === 'saving' ? 'Saving...' : 'Queued'}</span>
      {job.status === 'failed' && <button type="button" title={`Retry ${job.filename}`} aria-label={`Retry ${job.filename}`} onClick={() => onRetry(job.id)}><RotateCw size={16} /></button>}
    </li>)}</ul>
  </section>
}
