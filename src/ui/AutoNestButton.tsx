import { useLayoutEffect, useRef, useState } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'

interface Props {
  parts: Part[]
  sheet: Sheet
  accountId?: string
  onComplete: (instances: PartInstance[]) => void
  onStatus: (message: string) => void
}
interface Reply { instances?: PartInstance[]; error?: string; progress?: { completed: number; total: number } }
type Inputs = Pick<Props, 'parts' | 'sheet' | 'accountId'>

export function AutoNestButton({ parts, sheet, accountId, onComplete, onStatus }: Props) {
  const [state, setState] = useState<{ snapshot: Inputs; progress: { completed: number; total: number } }>()
  const progress = state?.snapshot.parts === parts && state.snapshot.sheet === sheet && state.snapshot.accountId === accountId ? state.progress : undefined
  const inputs = useRef<Inputs>({ parts, sheet, accountId })
  const running = useRef<{ worker: Worker; timer: ReturnType<typeof setTimeout>; snapshot: Inputs } | undefined>(undefined)

  function stop() {
    const request = running.current
    running.current = undefined
    if (request) { request.worker.terminate(); clearTimeout(request.timer) }
  }

  useLayoutEffect(() => {
    inputs.current = { parts, sheet, accountId }
    const snapshot = running.current?.snapshot
    if (snapshot && (snapshot.parts !== parts || snapshot.sheet !== sheet || snapshot.accountId !== accountId)) {
      stop(); onStatus('Sheet or account changed; auto nesting cancelled. No nesting changes applied.')
    }
  }, [parts, sheet, accountId, onStatus])
  useLayoutEffect(() => () => stop(), [])

  function start() {
    if (running.current) return
    try {
      const worker = new Worker(new URL('../nesting/worker.ts', import.meta.url), { type: 'module' })
      const snapshot = inputs.current
      const timer = setTimeout(() => {
        if (running.current?.worker !== worker) return
        stop(); setState(undefined)
        onStatus('Auto nesting timed out after 30 seconds. Your sheet is unchanged. Try fewer parts or send an exported project for investigation.')
      }, 30000)
      const request = { worker, timer, snapshot }
      running.current = request
      setState({ snapshot, progress: { completed: 0, total: sheet.instances.filter(instance => !instance.locked).length } })
      onStatus('Auto nesting...')
      const isCurrent = () => running.current === request && inputs.current.parts === snapshot.parts && inputs.current.sheet === snapshot.sheet && inputs.current.accountId === snapshot.accountId
      const fail = (message: string) => {
        if (!isCurrent()) return
        stop(); setState(undefined); onStatus(`${message} Your sheet is unchanged.`)
      }
      worker.onmessage = (event: MessageEvent<Reply>) => {
        if (!isCurrent()) return
        if (event.data.progress) { setState({ snapshot, progress: event.data.progress }); return }
        if (event.data.error) { fail(`Auto nesting failed: ${event.data.error}`); return }
        if (!event.data.instances) { fail('Auto nesting returned no layout.'); return }
        const instances = event.data.instances
        stop(); setState(undefined)
        onComplete(instances)
        const rotated = instances.filter((instance, i) => instance.rotation !== snapshot.sheet.instances[i].rotation).length
        onStatus(`Auto nesting complete: ${rotated} part${rotated === 1 ? '' : 's'} reoriented; ${Math.max(1, ...instances.map(instance => instance.sheetIndex + 1))} sheet(s). Locked parts unchanged.`)
      }
      worker.onerror = () => fail('Auto nesting could not complete.')
      worker.onmessageerror = () => fail('Auto nesting returned unreadable data.')
      const ids = new Set(sheet.instances.map(instance => instance.partId))
      worker.postMessage({ parts: parts.filter(part => ids.has(part.id)), sheet })
    } catch (error) {
      stop(); setState(undefined)
      onStatus(`Auto nesting failed: ${error instanceof Error ? error.message : 'Worker unavailable.'} Your sheet is unchanged.`)
    }
  }

  return <>
    <button type="button" className="icon-text-button" style={{ minWidth: 116 }} aria-label="Auto Nest" aria-busy={Boolean(progress)} disabled={Boolean(progress) || !sheet.instances.some(instance => !instance.locked)} onClick={start}>
      {progress && <LoaderCircle size={16} />} {progress ? `Nesting ${progress.completed}/${progress.total}` : 'Auto Nest'}
    </button>
    {progress && <button type="button" className="icon-button" title="Cancel auto nesting" aria-label="Cancel auto nesting" onClick={() => { stop(); setState(undefined); onStatus('Auto nesting cancelled. Your sheet is unchanged.') }}><X size={16} /></button>}
  </>
}
