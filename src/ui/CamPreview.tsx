import { useEffect, useRef, useState } from 'react'
import { Maximize, Pause, Play, ZoomIn, ZoomOut } from 'lucide-react'
import type { CamResult } from '../cam/types'
import type { Point } from '../models/geometry'
import { operationColors, operationDashes, operationNames, tabColor, tabOutlineColor } from './camAppearance'
import { CamOperationSwatch } from './CamOperationSwatch'

export function CamPreview({ result, selected, onSelect }: { result?: CamResult; selected?: string; onSelect: (id: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const transform = useRef({ scale: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const [size, setSize] = useState({ width: 800, height: 520 })
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [progress, setProgress] = useState(100)
  const [playing, setPlaying] = useState(false)
  const [rapids, setRapids] = useState(false)
  const [drawing, setDrawing] = useState(true)
  useEffect(() => {
    const parent = canvas.current?.parentElement
    if (!parent) return
    const observer = new ResizeObserver(entries => setSize({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }))
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => setProgress(value => {
      if (value >= 100) { setPlaying(false); return 100 }
      return Math.min(100, value + 0.5)
    }), 40)
    return () => window.clearInterval(timer)
  }, [playing])
  useEffect(() => {
    const c = canvas.current, ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const ratio = window.devicePixelRatio || 1
    c.width = Math.max(1, size.width * ratio); c.height = Math.max(1, size.height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.fillStyle = '#f7fafb'; ctx.fillRect(0, 0, size.width, size.height)
    const points = result?.drawing.features.flatMap(f => f.points) ?? []
    points.push(...(result?.operations.flatMap(o => o.path) ?? []))
    const maxX = Math.max(100, ...points.map(p => p.x)), maxY = Math.max(100, ...points.map(p => p.y))
    const scale = Math.min((size.width - 70) / maxX, (size.height - 65) / maxY) * zoom
    const x = (size.width - maxX * scale) / 2 + pan.x, y = (size.height + maxY * scale) / 2 + pan.y
    transform.current = { scale, x, y }
    const screen = (p: Point) => ({ x: x + p.x * scale, y: y - p.y * scale })
    const path = (points: Point[], color: string, width: number, closed = false, dash: number[] = []) => {
      if (!points.length) return
      ctx.beginPath(); points.forEach((p, i) => { const q = screen(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y) })
      if (closed) ctx.closePath()
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([])
    }
    const step = 10 ** Math.floor(Math.log10(Math.max(maxX, maxY) / 8))
    ctx.strokeStyle = '#e0e7ea'; ctx.lineWidth = 1
    for (let g = 0; g <= maxX; g += step) path([{ x: g, y: 0 }, { x: g, y: maxY }], '#e0e7ea', 1)
    for (let g = 0; g <= maxY; g += step) path([{ x: 0, y: g }, { x: maxX, y: g }], '#e0e7ea', 1)
    ctx.fillStyle = '#57626c'; ctx.font = '11px system-ui'; ctx.fillText('X0 Y0', x, y + 18)
    if (!result) { ctx.fillText('No drawing', size.width / 2 - 28, size.height / 2); return }
    if (drawing) for (const f of result.drawing.features) {
      path(f.points, f.id === selected ? '#1f2933' : '#a9b4bc', f.id === selected ? 2 : 1, f.closed, [3, 4])
    }
    const moves = result.simulation.moves
    const visible = moves.slice(0, Math.ceil(moves.length * progress / 100))
    let operationIndex = 0
    for (const move of visible) {
      while (operationIndex < result.operations.length - 1 && move.lineNumber > result.operations[operationIndex].lastLine) operationIndex++
      const operation = result.operations[operationIndex]
      if (move.type === 'rapid') { if (rapids) path([move.start, move.end], '#96a2aa', 1, false, [4, 5]); continue }
      const kind = operation?.kind ?? 'unassigned'
      const color = operationColors[kind]
      path(move.points, color, operation?.featureId === selected ? 3 : 1.75, false, operationDashes[kind])
      if (Math.hypot(move.end.x - move.start.x, move.end.y - move.start.y) < 0.001 && move.end.z < 0) {
        const p = screen(move.end), radius = Math.max(kind === 'drill' ? 4.5 : 2, 3.175 * scale)
        ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.strokeStyle = color; ctx.stroke()
        if (kind === 'drill') {
          ctx.beginPath(); ctx.moveTo(p.x - radius * 0.6, p.y); ctx.lineTo(p.x + radius * 0.6, p.y)
          ctx.moveTo(p.x, p.y - radius * 0.6); ctx.lineTo(p.x, p.y + radius * 0.6); ctx.stroke()
        }
      }
    }
    for (const op of result.operations) for (const tab of op.tabs) {
      path(tab.points, tabOutlineColor, 7)
      path(tab.points, tabColor, 4)
    }
    const head = visible.at(-1)?.end
    if (head && progress < 100) { const p = screen(head); ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fillStyle = '#17242d'; ctx.fill() }
  }, [result, selected, zoom, pan, progress, rapids, drawing, size])
  const fit = () => { setZoom(1); setPan({ x: 0, y: 0 }) }
  return <section className="cam-preview" aria-label="Toolpath preview">
    <div className="cam-preview-tools">
      <div className="cam-icon-group">
        <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => setZoom(z => Math.min(20, z * 1.25))}><ZoomIn size={17} /></button>
        <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => setZoom(z => Math.max(0.25, z / 1.25))}><ZoomOut size={17} /></button>
        <button type="button" title="Fit drawing" aria-label="Fit drawing" onClick={fit}><Maximize size={17} /></button>
      </div>
      <label><input type="checkbox" checked={drawing} onChange={e => setDrawing(e.target.checked)} />DXF</label>
      <label><input type="checkbox" checked={rapids} onChange={e => setRapids(e.target.checked)} />Rapids</label>
    </div>
    <div className="cam-canvas-wrap">
      <canvas ref={canvas} aria-label="DXF and generated G-code toolpaths with operation colours, line patterns and drill symbols"
        onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={e => { const d = drag.current; if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y; if (Math.hypot(dx, dy) > 2 || d.moved) { d.moved = true; setPan(p => ({ x: p.x + dx, y: p.y + dy })); d.x = e.clientX; d.y = e.clientY } }}
        onPointerUp={e => {
          if (!drag.current?.moved && result) {
            const rect = e.currentTarget.getBoundingClientRect(), t = transform.current
            const p = { x: (e.clientX - rect.left - t.x) / t.scale, y: (t.y - (e.clientY - rect.top)) / t.scale }
            let nearest: { id: string; distance: number } | undefined
            for (const f of result.drawing.features) for (let i = 0; i < f.points.length; i++) {
              const a = f.points[i], b = f.points[(i + 1) % f.points.length], dx = b.x - a.x, dy = b.y - a.y
              const r = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
              const distance = Math.hypot(p.x - a.x - dx * r, p.y - a.y - dy * r)
              if (!nearest || distance < nearest.distance) nearest = { id: f.id, distance }
            }
            if (nearest && nearest.distance * t.scale < 18) onSelect(nearest.id)
          }
          drag.current = null
        }} onPointerCancel={() => { drag.current = null }} />
    </div>
    <div className="cam-playback">
      <button type="button" disabled={!result?.operations.length} title={playing ? 'Pause preview' : 'Play preview'} aria-label={playing ? 'Pause preview' : 'Play preview'} onClick={() => { if (progress >= 100) setProgress(0); setPlaying(p => !p) }}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
      <input aria-label="Toolpath progress" type="range" min="0" max="100" step="0.1" value={progress} onChange={e => { setPlaying(false); setProgress(Number(e.target.value)) }} />
      <output>{Math.round(progress)}%</output>
    </div>
    <div className="cam-legend" aria-label="Operation legend">{(['outside', 'inside', 'drill', 'pocket'] as const).map(kind => <span key={kind}><CamOperationSwatch kind={kind} />{operationNames[kind]}</span>)}<span><i className="cam-tab-swatch" aria-hidden="true" style={{ backgroundColor: tabColor, borderColor: tabOutlineColor }} />Tabs</span></div>
  </section>
}
