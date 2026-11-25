import type { PlanningProgress, ReportPlanningProgress } from '../jobs/planningProgress'
import { useEffect, useRef, useState } from 'react'
import type { SheetWorkspace } from '../jobs/production'
import { DailyPlanPanel } from './DailyPlanPanel'
export function DailyPlanDialog({
  onPrepare,
  onApply,
  onClose
}: {
  onPrepare: (signal: AbortSignal, onProgress: ReportPlanningProgress) => Promise<SheetWorkspace>
  onApply: (workspace: SheetWorkspace) => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    prepare = useRef(onPrepare)
  const [progress, setProgress] = useState<PlanningProgress>({ percent: 0, message: 'Preparing the day plan…' })
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
      .current(abort.signal, (next) => {
        if (!abort.signal.aborted && Number.isFinite(next.percent))
          setProgress((previous) => ({
            message: next.message,
            percent: Math.max(previous.percent, Math.min(99, Math.max(0, Math.round(next.percent))))
          }))
      })
      .then((r) => {
        if (!abort.signal.aborted) {
          setProgress({ percent: 100, message: 'Day plan ready' })
          setResult(r)
        }
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
      {!error && (
        <div className="day-planning-progress" aria-busy={!result}>
          <div>
            <label htmlFor="day-planning-progress">
              {result ? 'Planning complete' : 'Estimated planning progress'}
            </label>
            <strong>{progress.percent}%</strong>
          </div>
          <progress id="day-planning-progress" aria-label="Day planning progress" max={100} value={progress.percent} />
          <p role="status">{progress.message}</p>
        </div>
      )}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setResult(undefined)
              setProgress({ percent: 0, message: 'Preparing the day plan…' })
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
