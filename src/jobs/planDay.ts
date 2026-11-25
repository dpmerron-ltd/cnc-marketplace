import type { DailyPlanInput } from './dailyPlan'
import type { SheetWorkspace } from './production'
export function planDay(input: DailyPlanInput, signal: AbortSignal): Promise<SheetWorkspace> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const worker = new Worker(new URL('./dailyPlan.worker.ts', import.meta.url), { type: 'module' })
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      worker.terminate()
    }
    const cancel = () => {
      finish()
      reject(new Error('Planning cancelled.'))
    }
    const timer = setTimeout(() => {
      finish()
      reject(new Error('Planning timed out. No changes were saved.'))
    }, 180000)
    signal.addEventListener('abort', cancel, { once: true })
    worker.onmessage = (event) => {
      finish()
      if (event.data.error) reject(new Error(event.data.error))
      else resolve(event.data.workspace)
    }
    worker.onerror = () => {
      finish()
      reject(new Error('Planning failed. No changes were saved.'))
    }
    worker.postMessage(input)
  })
}
