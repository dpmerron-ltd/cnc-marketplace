import { useEffect, useRef, useState } from 'react'
import type { SheetWorkspace } from '../jobs/production'
import { DailyPlanPanel } from './DailyPlanPanel'
export function DailyPlanDialog({
  onPrepare,
  onApply,
  onClose
}: {
  onPrepare: (signal: AbortSignal) => Promise<SheetWorkspace>
  onApply: (workspace: SheetWorkspace) => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    prepare = useRef(onPrepare)
  const [result, setResult] = useState<SheetWorkspace>(),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0),
    [saving, setSaving] = useState(false)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    void prepare
      .current(abort.signal)
      .then((r) => {
        if (!abort.signal.aborted) setResult(r)
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError((e as Error).message)
      })
    return () => abort.abort()
  }, [attempt])
  return (
    <dialog
      ref={dialog}
      className="daily-plan-dialog"
      aria-labelledby="daily-plan-title"
      onCancel={(e) => {
        if (saving) e.preventDefault()
        else onClose()
      }}
    >
      <div className="queue-heading">
        <h2 id="daily-plan-title">Plan today’s cuts</h2>
        <button type="button" disabled={saving} onClick={onClose}>
          Close
        </button>
      </div>
      {!result && !error && (
        <p role="status">Loading all open orders, nesting compatible parts and estimating cutting times…</p>
      )}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setResult(undefined)
              setError('')
              setAttempt((n) => n + 1)
            }}
          >
            Try again
          </button>
        </>
      )}
      {result?.dailyPlan && (
        <>
          <DailyPlanPanel plan={result.dailyPlan} />
          <p>
            Save creates waiting sheets for newly imported orders, including work that rolls over. It does not start
            either machine. Review and export each sheet through Cutting Jobs; its labels retain each part’s order
            number.
          </p>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setSaving(true)
              void onApply(result)
                .then(onClose)
                .catch((e) => setError((e as Error).message))
                .finally(() => setSaving(false))
            }}
          >
            {saving ? 'Saving…' : 'Save day plan'}
          </button>
        </>
      )}
    </dialog>
  )
}
