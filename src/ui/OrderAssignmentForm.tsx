import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Save, Users } from 'lucide-react'
import { jobApiRequest } from '../storage/jobsApi'
import type { OrderAssignment, OrderUser } from '../orders/types'

export function cuttingPayment(assignment?: OrderAssignment | null) {
  return assignment?.payment_pence != null ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(assignment.payment_pence / 100) : 'Not set'
}

export function OrderAssignmentForm({ userId, orderId, assignment, onSaved, onReload }: {
  userId: string; orderId: string; assignment?: OrderAssignment | null
  onSaved: (assignment: OrderAssignment) => void; onReload: () => void
}) {
  const [users, setUsers] = useState<OrderUser[]>([])
  const [offset, setOffset] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(-1)
  const [retry, setRetry] = useState(0)
  const [userError, setUserError] = useState('')
  const [assignee, setAssignee] = useState(assignment?.assignee_id ?? '')
  const [amount, setAmount] = useState(assignment?.payment_pence != null ? (assignment.payment_pence / 100).toFixed(2) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const abort = useRef<AbortController | null>(null)
  useEffect(() => { const controller = new AbortController(); abort.current = controller; return () => controller.abort() }, [])
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const result: { users: OrderUser[]; nextOffset: number | null } = await (await jobApiRequest(`/shopify/users?offset=${offset}`, userId, { signal: controller.signal })).json()
        if (controller.signal.aborted) return
        setUsers(previous => [...new Map([...previous, ...result.users].map(u => [u.id, u])).values()])
        setNextOffset(result.nextOffset); setUserError('')
      } catch (e) { if (!controller.signal.aborted) setUserError((e as Error).message) }
      finally { if (!controller.signal.aborted) setLoaded(offset) }
    })()
    return () => controller.abort()
  }, [offset, userId, retry])

  async function save() {
    const valid = /^(0|[1-9]\d{0,6})(\.\d{1,2})?$/.test(amount)
    const pence = Math.round(Number(amount) * 100)
    if (assignee && (!valid || pence > 100000000)) { setError('Enter a GBP cutting payment with no more than two decimal places.'); return }
    setSaving(true); setError('')
    const signal = abort.current!.signal
    try {
      const result: { assignment: OrderAssignment } = await (await jobApiRequest(`/shopify/orders/${orderId}/assignment`, userId, {
        method: 'PATCH', signal,
        body: JSON.stringify({ assigneeId: assignee || null, paymentPence: assignee ? pence : null, expectedVersion: assignment?.version ?? 0 }),
      })).json()
      if (!signal.aborted) onSaved(result.assignment)
    } catch (e) { if (!signal.aborted) setError((e as Error).message) }
    finally { if (!signal.aborted) setSaving(false) }
  }
  return <form className="order-assignment" onSubmit={e => { e.preventDefault(); void save() }} aria-label="Order assignment">
    <h4>Assignment</h4>
    <div className="orders-filters">
      <label>Assigned to<select value={assignee} disabled={saving} onChange={e => setAssignee(e.target.value)}>
        <option value="">Unassigned</option>
        {assignment?.assignee_id && !users.some(u => u.id === assignment.assignee_id) && <option value={assignment.assignee_id}>{assignment.assignee_email ?? assignment.assignee_id}</option>}
        {users.map(u => <option key={u.id} value={u.id}>{u.email}</option>)}
      </select></label>
      <label>Cutting payment (GBP / order)<input type="number" min="0" max="1000000" step="0.01" inputMode="decimal" required={Boolean(assignee)} disabled={!assignee || saving} value={amount} onChange={e => setAmount(e.target.value)} /></label>
      <button type="submit" className="icon-text-button" disabled={saving || loaded !== offset}><Save size={16} />{saving ? 'Saving...' : 'Save assignment'}</button>
      {nextOffset !== null && <button type="button" className="icon-text-button" disabled={saving || loaded !== offset} onClick={() => setOffset(nextOffset)}><Users size={16} /> More users</button>}
    </div>
    {userError && <div className="orders-detail-error"><p role="alert">{userError}</p><button type="button" className="icon-text-button" onClick={() => { setLoaded(-1); setRetry(v => v + 1) }}><RefreshCw size={16} /> Retry users</button></div>}
    {error && <div className="orders-detail-error"><p className="queue-error" role="alert">{error}</p><button type="button" className="icon-text-button" onClick={onReload}><RefreshCw size={16} /> Reload assignment</button></div>}
  </form>
}
