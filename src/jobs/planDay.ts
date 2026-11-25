import type { ReportPlanningProgress } from './planningProgress'
import type { DailyPlanInput } from './dailyPlan'
import type { SheetWorkspace } from './production'
export function planDay(
  input: DailyPlanInput,
  signal: AbortSignal,
  onProgress?: ReportPlanningProgress
): Promise<SheetWorkspace> {
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
      if (event.data.progress) {
        onProgress?.(event.data.progress)
        return
      }
      finish()
      if (event.data.error) reject(new Error(event.data.error))
      else if (event.data.workspace) resolve(event.data.workspace)
      else reject(new Error('Planning returned no result. No changes were saved.'))
    }
    worker.onerror = () => {
      finish()
      reject(new Error('Planning failed. No changes were saved.'))
    }
    worker.postMessage(input)
  })
}
