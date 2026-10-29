import type { Part } from '../models/Part'
import type { SheetWorkspace } from './production'

export function replanWaiting(workspace: SheetWorkspace, parts: Part[]): Promise<SheetWorkspace> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./production.worker.ts', import.meta.url), { type: 'module' })
    const finish = () => { clearTimeout(timeout); worker.terminate() }
    const timeout = setTimeout(() => { finish(); reject(new Error('Re-planning took too long. The saved plan has not changed.')) }, 180_000)
    worker.onmessage = event => { finish(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.workspace) }
    worker.onerror = event => { finish(); reject(new Error(event.message || 'Re-planning failed. The saved plan has not changed.')) }
    worker.postMessage({ workspace, parts })
  })
}
