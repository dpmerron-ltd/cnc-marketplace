import { useEffect, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { ParsedStl } from '../printing/types'
import { createStlView } from '../printing/stlView'

export function StlPreview({ model, name, onReady }: { model: ParsedStl; name: string; onReady?: (capture: () => Promise<Blob>) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const view = useRef<ReturnType<typeof createStlView> | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setError('')
    try { view.current = createStlView(canvas.current!, model); onReady?.(view.current.image) }
    catch { setError('3D rendering is unavailable. Enable WebGL or try another browser.') }
    return () => { view.current?.dispose(); view.current = null }
  }, [model, onReady])
  return <div className="stl-stage">
    <canvas ref={canvas} aria-label={`3D preview of ${name}`} role="img" />
    {!error && <button type="button" className="icon-button stl-reset" title="Reset view" aria-label="Reset view" onClick={() => view.current?.reset()}><RotateCcw size={18} /></button>}
    {error && <p role="alert" className="stl-render-error">{error}</p>}
  </div>
}
