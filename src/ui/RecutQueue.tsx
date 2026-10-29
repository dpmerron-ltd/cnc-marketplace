import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { recutSourceLink, recutStatusNames, type MachineRecut, type RecutStatus } from '../machine/recuts'
import { changeMachineRecutStatus, listMachineRecuts } from '../storage/machineRecutsStore'
import './RecutQueue.css'

export interface RecutSheetTarget {
  onAddRecut?: (entry: MachineRecut, signal: AbortSignal) => Promise<void>
  addedRecuts?: string[]
  sheetName?: string
}
export function RecutQueue({ userId, refresh = 0, ...target }: { userId: string; refresh?: number } & RecutSheetTarget) {
  return <AccountRecutQueue key={userId} userId={userId} refresh={refresh} {...target} />
}

function AccountRecutQueue({ userId, refresh, onAddRecut, addedRecuts = [], sheetName }: { userId: string; refresh: number } & RecutSheetTarget) {
  const [entries, setEntries] = useState<MachineRecut[]>([])
  const [status, setStatus] = useState<RecutStatus | ''>('queued')
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [loadedKey, setLoadedKey] = useState('')
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const lifetime = useRef<AbortController | undefined>(undefined)
  const pending = useRef(false)
  const requestKey = `${userId}:${status}:${offset}:${revision}:${refresh}`
  const loading = loadedKey !== requestKey

  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    return () => abort.abort()
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    void listMachineRecuts(userId, offset, status, abort.signal).then(value => {
      if (!abort.signal.aborted) { setEntries(value); setError('') }
    }).catch(cause => {
      if (!abort.signal.aborted) { setEntries([]); setError((cause as Error).message) }
    }).finally(() => { if (!abort.signal.aborted) setLoadedKey(requestKey) })
    return () => abort.abort()
  }, [userId, offset, status, requestKey])

  async function update(entry: MachineRecut, next: Exclude<RecutStatus, 'queued'>) {
    if (pending.current) return
    pending.current = true
    const signal = lifetime.current!.signal
    setBusyId(entry.id); setError(''); setNotice('')
    try {
      await changeMachineRecutStatus(userId, entry, next)
      if (!signal.aborted) {
        setNotice(`${entry.part_number} ${next === 'completed' ? 'marked as re-cut' : 'removed from the re-cut queue'}.`)
        setRevision(value => value + 1)
      }
    } catch (cause) { if (!signal.aborted) setError((cause as Error).message) }
    finally { if (!signal.aborted) { pending.current = false; setBusyId(undefined) } }
  }

  async function add(entry: MachineRecut) {
    if (!onAddRecut || pending.current) return
    pending.current = true; setBusyId(entry.id); setError('')
    const signal = lifetime.current!.signal
    try { await onAddRecut(entry, signal); if (!signal.aborted) setNotice(`${entry.part_number} added to the selected job.`) }
    catch (cause) { if (!signal.aborted) setError((cause as Error).message) }
    finally { if (!signal.aborted) { pending.current = false; setBusyId(undefined) } }
  }

  return <section className="recut-queue" aria-label="Re-cut parts">
    <h3>Re-cut parts</h3>
    <p>Select a part in Cutting Jobs and choose Re-cut to add it here. Each entry requests one replacement part.</p>
    {onAddRecut && <p>Adding replacements to: <strong>{sheetName}</strong>. Select another job in the Sheet tab to change the destination.</p>}
    <div className="queue-filters"><label>Re-cut status<select value={status} disabled={Boolean(busyId)} onChange={event => { setStatus(event.target.value as RecutStatus | ''); setOffset(0); setNotice('') }}><option value="">All re-cuts</option>{Object.entries(recutStatusNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label></div>
    {!loading && error && <p role="alert" className="queue-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">Loading re-cut parts...</p> : <>
      <div className="queue-table-scroll"><table className="queue-table"><thead><tr><th>Part / Source</th><th>Job / Order</th><th>Stock</th><th>Status</th><th>Requested</th><th>Actions</th></tr></thead><tbody>{entries.map(entry => <tr key={entry.id}>
        <td><a href={recutSourceLink(entry)}>{entry.part_number} · {entry.part_name}</a><span className="queue-order">Sheet {entry.sheet_index + 1}</span></td>
        <td>{entry.job_name}<span className="queue-order">Order {entry.order_number}</span></td>
        <td>{entry.material}<span className="queue-order">{entry.thickness}</span></td>
        <td>{recutStatusNames[entry.status]}</td>
        <td>{new Date(entry.created_at).toLocaleString()}</td>
        <td>{entry.status === 'queued' && <div className="recut-actions">{onAddRecut && <button type="button" disabled={Boolean(busyId) || addedRecuts.includes(entry.id)} onClick={() => void add(entry)}>{addedRecuts.includes(entry.id) ? 'Added to job' : 'Add to sheet'}</button>}<button type="button" disabled={Boolean(busyId)} onClick={() => void update(entry, 'completed')}>Mark re-cut</button><button type="button" disabled={Boolean(busyId)} onClick={() => void update(entry, 'cancelled')}>Remove</button></div>}</td>
      </tr>)}</tbody></table></div>
      {!error && !entries.length && <p>{status === 'queued' ? 'No parts waiting to be re-cut.' : 'No re-cuts found.'}</p>}
    </>}
    <div className="label-pagination"><button type="button" className="icon-button" aria-label="Previous re-cuts" disabled={!offset || loading || Boolean(busyId)} onClick={() => setOffset(Math.max(0, offset - 25))}><ChevronLeft size={18} /></button><span>Page {offset / 25 + 1}</span><button type="button" className="icon-button" aria-label="Next re-cuts" disabled={entries.length < 25 || loading || Boolean(busyId)} onClick={() => setOffset(offset + 25)}><ChevronRight size={18} /></button></div>
  </section>
}
