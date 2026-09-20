import { useEffect, useState } from 'react'
import type { PackingEstimate } from './types'

export function usePackingEstimates(jobs: string | undefined) {
  const [state, setState] = useState<{ input?: string; results: Record<string, { result?: PackingEstimate; error?: string }> }>({ results: {} })
  useEffect(() => {
    if (!jobs || typeof Worker === 'undefined') return
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    let active = true
    worker.onmessage = event => { if (active) setState(state => ({ input: jobs, results: { ...(state.input === jobs ? state.results : {}), [event.data.id]: event.data } })) }
    worker.onerror = () => { if (active) setState({ input: jobs, results: Object.fromEntries(JSON.parse(jobs).map((item: { id: string }) => [item.id, { error: 'Packing calculation unavailable.' }])) }) }
    worker.postMessage(JSON.parse(jobs))
    return () => { active = false; worker.terminate() }
  }, [jobs])
  return jobs && state.input === jobs ? state.results : {}
}
