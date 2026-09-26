import { maxStlBytes, type ParsedStl } from './types'

export async function readStl(file: Blob, signal: AbortSignal): Promise<ParsedStl> {
  if (!file.size || file.size > maxStlBytes) throw new Error('Choose an STL file up to 25 MB.')
  const buffer = await file.arrayBuffer()
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./stl.worker.ts', import.meta.url), { type: 'module' })
    const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('STL processing timed out. Simplify the mesh and try again.')) }, 30000)
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate() }
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<{ mesh?: ParsedStl; error?: string }>) => {
      cleanup()
      if (event.data.mesh) resolve(event.data.mesh)
      else reject(new Error(event.data.error ?? 'STL could not be read.'))
    }
    worker.onerror = () => { cleanup(); reject(new Error('STL preview could not load. Reload the page and try again.')) }
    worker.postMessage(buffer, [buffer])
  })
}
