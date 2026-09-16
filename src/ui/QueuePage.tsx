import { useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Copy, Download, KeyRound, Plus, RefreshCw, X } from 'lucide-react'
import type { CuttingJob, JobStatus, JobSummary } from '../jobs/types'
import { downloadJobFile, jobApiRequest, jobsApiUrl } from '../storage/jobsApi'
import { supabase } from '../storage/supabaseClient'

const statusNames: Record<JobStatus, string> = { awaiting_review: 'Awaiting review', ready: 'Ready', cutting: 'Cutting', completed: 'Completed', cancelled: 'Cancelled' }
interface ApiKey { id: string; name: string; token_prefix: string; expires_at: string; revoked_at: string | null; expired: boolean }

export function QueuePage({ userId }: { userId: string }) {
  const [tab, setTab] = useState<'queue' | 'keys'>('queue')
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [job, setJob] = useState<CuttingJob>()
  const [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [loadedKey, setLoadedKey] = useState('')
  const requestKey = `${tab}:${offset}:${status}:${revision}`
  const loading = loadedKey !== requestKey
  const [busy, setBusy] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [error, setError] = useState('')
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [keyName, setKeyName] = useState('Order automation')
  const [newKey, setNewKey] = useState('')
  const [copied, setCopied] = useState(false)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const selection = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => controller.abort()
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    void (async () => {
      try {
        if (tab === 'queue') {
          const response = await jobApiRequest(`/jobs?limit=25&offset=${offset}${status ? `&status=${status}` : ''}`, userId, { signal: abort.signal })
          const data = await response.json()
          if (!abort.signal.aborted) setJobs(data.jobs)
        } else if (supabase) {
          const result = await supabase.from('cnc_api_keys').select('id,name,token_prefix,expires_at,revoked_at').eq('owner_id', userId).order('created_at', { ascending: false }).abortSignal(abort.signal)
          if (result.error) throw new Error(result.error.message)
          if (!abort.signal.aborted) setKeys((result.data ?? []).map(key => ({ ...key, expired: Date.parse(key.expires_at) <= Date.now() })))
        }
        if (!abort.signal.aborted) setError('')
      } catch (error) { if (!abort.signal.aborted) setError((error as Error).message) }
      finally { if (!abort.signal.aborted) setLoadedKey(requestKey) }
    })()
    return () => abort.abort()
  }, [userId, tab, offset, status, revision, requestKey])

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    const signal = lifetime.current!.signal
    setBusy(true); setError('')
    try { await action(signal) }
    catch (error) { if (!signal.aborted) setError((error as Error).message) }
    finally { if (!signal.aborted) setBusy(false) }
  }
  async function selectJob(id: string) {
    const selected = ++selection.current
    setJob(undefined); setReviewed(false)
    await run(async signal => {
      const response = await jobApiRequest(`/jobs/${id}`, userId, { signal })
      const data = await response.json()
      if (!signal.aborted && selection.current === selected) setJob(data)
    })
  }
  async function transition(next: JobStatus) {
    if (!job) return
    if (next === 'cancelled' && !window.confirm('Cancel this job? This does not stop a running machine.')) return
    await run(async signal => {
      const response = await jobApiRequest(`/jobs/${job.id}`, userId, { method: 'PATCH', signal, body: JSON.stringify({ status: next, expectedStatus: job.status, reviewConfirmed: reviewed }) })
      const data = await response.json()
      if (!signal.aborted) { setJob(data); setReviewed(false); setRevision(value => value + 1) }
    })
  }
  async function createKey() {
    await run(async signal => {
      const result = await supabase!.rpc('create_cnc_api_key', { p_name: keyName.trim() })
      if (result.error) throw new Error(result.error.message)
      if (!signal.aborted) { setNewKey(result.data.token); setCopied(false); setRevision(value => value + 1) }
    })
  }
  async function revokeKey(key: ApiKey) {
    if (!window.confirm(`Revoke API key "${key.name}"?`)) return
    await run(async signal => {
      const result = await supabase!.rpc('revoke_cnc_api_key', { p_id: key.id })
      if (result.error) throw new Error(result.error.message)
      if (!signal.aborted) { setNewKey(''); setRevision(value => value + 1) }
    })
  }

  return <main className="queue-page">
    <div className="queue-heading">
      <h2>Cutting Queue</h2>
      <div className="button-row">
        <button type="button" className={tab === 'queue' ? 'active-nav' : ''} onClick={() => { setTab('queue'); setNewKey('') }}>Jobs</button>
        <button type="button" className={`icon-text-button ${tab === 'keys' ? 'active-nav' : ''}`} onClick={() => setTab('keys')}><KeyRound size={16} /> API Access</button>
        <button type="button" className="icon-button" title="Refresh queue" aria-label="Refresh queue" disabled={loading || busy} onClick={() => { setRevision(value => value + 1); if (job && tab === 'queue') void selectJob(job.id) }}><RefreshCw size={17} /></button>
      </div>
    </div>
    {error && <p className="queue-error" role="alert">{error}</p>}
    {tab === 'keys' ? <section className="api-access">
      <label>API base URL<input readOnly value={jobsApiUrl} /></label>
      <a href="https://github.com/dpmerron-ltd/cnc-marketplace/blob/main/docs/API.md" target="_blank" rel="noreferrer">API Reference</a>
      <div className="api-key-create"><label>Key name<input maxLength={80} value={keyName} onChange={event => setKeyName(event.target.value)} /></label><button type="button" className="icon-text-button" disabled={busy || !keyName.trim() || Boolean(newKey)} onClick={() => void createKey()}><Plus size={16} /> Create key</button></div>
      {newKey && <div className="api-key-secret"><label>New key (shown once)<input aria-label="New API key" type="password" readOnly value={newKey} /></label><button type="button" className="icon-button" aria-label="Copy API key" title={copied ? 'Copied' : 'Copy API key'} onClick={() => void run(async signal => { await navigator.clipboard.writeText(newKey); if (!signal.aborted) setCopied(true) })}>{copied ? <Check size={17} /> : <Copy size={17} />}</button><button type="button" className="icon-button" title="Dismiss new key" aria-label="Dismiss new key" onClick={() => setNewKey('')}><X size={17} /></button></div>}
      <div className="queue-table-scroll"><table className="queue-table"><thead><tr><th>Name</th><th>Prefix</th><th>Expires</th><th>Status</th><th /></tr></thead><tbody>{keys.map(key => <tr key={key.id}><td>{key.name}</td><td><code>{key.token_prefix}</code></td><td>{new Date(key.expires_at).toLocaleDateString()}</td><td>{key.revoked_at ? 'Revoked' : key.expired ? 'Expired' : 'Active'}</td><td><button type="button" disabled={busy || Boolean(key.revoked_at)} onClick={() => void revokeKey(key)}>Revoke</button></td></tr>)}</tbody></table></div>
      {!keys.length && !loading && <p>No API keys.</p>}
    </section> : <>
      <div className="queue-filters"><label>Status<select value={status} onChange={event => { setStatus(event.target.value); setOffset(0) }}><option value="">All jobs</option>{Object.entries(statusNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><span>{loading ? 'Loading...' : `${jobs.length} jobs`}</span></div>
      <div className="queue-table-scroll"><table className="queue-table"><thead><tr><th>Job / Order</th><th>Status</th><th>Sheets</th><th>Parts</th><th>Created</th></tr></thead><tbody>{jobs.map(entry => <tr key={entry.id} className={entry.id === job?.id ? 'selected-job' : ''}><td><button type="button" disabled={busy} onClick={() => void selectJob(entry.id)}>{entry.job_name}</button><span className="queue-order">{entry.order_number}</span></td><td>{statusNames[entry.status]}</td><td>{entry.sheet_count}</td><td>{entry.part_count}</td><td>{new Date(entry.created_at).toLocaleString()}</td></tr>)}</tbody></table></div>
      {!loading && !jobs.length && <p>No jobs in this queue.</p>}
      <div className="label-pagination"><button type="button" className="icon-button" aria-label="Previous jobs" title="Previous jobs" disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - 25))}><ChevronLeft size={18} /></button><span>Page {offset / 25 + 1}</span><button type="button" className="icon-button" aria-label="Next jobs" title="Next jobs" disabled={jobs.length < 25 || loading} onClick={() => setOffset(offset + 25)}><ChevronRight size={18} /></button></div>
      {job && <section className="queue-job">
        <div className="queue-heading"><div><h2>{job.job_name}</h2><p>Order {job.order_number} / {statusNames[job.status]}</p></div><div className="button-row">{job.status === 'awaiting_review' && <button type="button" className="primary" disabled={busy || !reviewed} onClick={() => void transition('ready')}>Mark ready</button>}{job.status === 'ready' && <button type="button" className="primary" disabled={busy} onClick={() => void transition('cutting')}>Mark cutting</button>}{job.status === 'cutting' && <button type="button" className="primary" disabled={busy} onClick={() => void transition('completed')}>Mark completed</button>}{!['completed', 'cancelled'].includes(job.status) && <button type="button" disabled={busy} onClick={() => void transition('cancelled')}>Cancel job</button>}</div></div>
        <p>{job.manifest.request.sheet.material} / {job.manifest.request.sheet.widthMm} x {job.manifest.request.sheet.heightMm} mm / Safe Z {job.manifest.request.sheet.safeZMm} mm</p>
        {job.manifest.request.notes && <p className="job-notes">{job.manifest.request.notes}</p>}
        <div className="button-row">{job.files.map(file => <button key={file.name} type="button" className="icon-text-button" disabled={busy} onClick={() => void run(signal => downloadJobFile(job.id, file.name, userId, signal))}><Download size={15} /> {file.name}</button>)}</div>
        <h3>Setup & Specifics</h3><ul>{job.manifest.setup.map((note, i) => <li key={i}>{note}</li>)}</ul>
        {job.manifest.warnings.length > 0 && <details className="queue-warnings"><summary>Warnings ({job.manifest.warnings.length})</summary><ul>{job.manifest.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
        {job.status === 'awaiting_review' && <label className="queue-review"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /> Stock, cutter, origin, clearances and job files reviewed</label>}
      </section>}
    </>}
  </main>
}
