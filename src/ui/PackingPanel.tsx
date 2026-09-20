import { useEffect, useRef, useState } from 'react'
import { Box, ChevronLeft, ChevronRight } from 'lucide-react'
import type { PackingEstimate, PackingPiece, PackingPlan, PackingSettings } from '../packing/types'
import { packingDefaults } from '../packing/packing'
import { boxSize } from '../packing/format'
import './PackingPanel.css'

const colors = ['#177b69', '#326ab5', '#985192', '#af6822', '#bd4b59', '#548032']

function PackingPreview({ plan, pieces }: { plan: PackingPlan; pieces: PackingPiece[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [layerIndex, setLayerIndex] = useState(0)
  const index = Math.min(layerIndex, plan.layers.length - 1)
  const layer = plan.layers[index]
  useEffect(() => {
    const canvas = ref.current, ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const scale = Math.min((canvas.width - 60) / plan.internal.length, (canvas.height - 60) / plan.internal.width)
    const ox = (canvas.width - plan.internal.length * scale) / 2, oy = (canvas.height - plan.internal.width * scale) / 2
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#81928d'; ctx.lineWidth = 2
    ctx.fillRect(ox, oy, plan.internal.length * scale, plan.internal.width * scale)
    ctx.strokeRect(ox, oy, plan.internal.length * scale, plan.internal.width * scale)
    for (const placement of layer.parts) {
      const number = pieces.findIndex(p => p.id === placement.id)
      const color = colors[number % colors.length]
      const x = ox + placement.x * scale, y = oy + placement.y * scale, w = placement.width * scale, h = placement.height * scale
      ctx.fillStyle = color + '25'; ctx.strokeStyle = color
      ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h)
      if (w > 16 && h > 16) { ctx.fillStyle = color; ctx.font = `bold ${Math.min(26, w / 2, h / 2)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(number + 1), x + w / 2, y + h / 2) }
    }
  }, [plan, pieces, layer])
  return <div className="packing-layout">
    <div className="packing-layer-bar"><button type="button" title="Previous layer" aria-label="Previous packing layer" disabled={index === 0} onClick={() => setLayerIndex(index - 1)}><ChevronLeft size={18} /></button><strong>Layer {index + 1} / {plan.layers.length}</strong><button type="button" title="Next layer" aria-label="Next packing layer" disabled={index === plan.layers.length - 1} onClick={() => setLayerIndex(index + 1)}><ChevronRight size={18} /></button><span>{layer.height} mm thick / base {Number(layer.z.toFixed(1))} mm</span></div>
    <canvas ref={ref} width={1000} height={500} role="img" aria-label={`Packing layout, layer ${index + 1}`} />
    <ul className="packing-legend">{layer.parts.map(p => <li key={p.id}><i style={{ background: colors[pieces.findIndex(piece => piece.id === p.id) % colors.length] }} /><strong>{pieces.findIndex(piece => piece.id === p.id) + 1}.</strong> {pieces.find(piece => piece.id === p.id)?.name} <span>{p.width.toFixed(1)} x {p.height.toFixed(1)} mm{p.rotated ? ' / rotated' : ''}</span></li>)}</ul>
  </div>
}

export function PackingPanel({ pieces, settings = {}, estimate, error, onChange }: { pieces: PackingPiece[]; settings?: PackingSettings; estimate?: PackingEstimate; error?: string; onChange: (settings: PackingSettings) => void }) {
  const [choice, setChoice] = useState(0)
  const boxIndex = Math.min(choice, (estimate?.boxes.length ?? 1) - 1)
  const plan = estimate?.boxes[boxIndex]
  const effective = { ...packingDefaults, ...settings }
  function measurement(id: string, field: 'widthMm' | 'heightMm' | 'thicknessMm', value: string) {
    const current = { ...settings.components?.[id] }
    if (value === '') delete current[field]
    else current[field] = Number(value)
    onChange({ ...settings, components: { ...settings.components, [id]: current } })
  }
  return <section className="packing-section" aria-label="Packing estimate">
    <header className="packing-heading"><h3><Box size={20} /> Packing boxes</h3><span>Internal carton sizes / single box preferred</span></header>
    <div className="packing-allowances">
      <label>Outer padding (mm)<input type="number" min="0" max="50" step="1" value={effective.paddingMm} onChange={e => onChange({ ...settings, paddingMm: Number(e.target.value) })} /></label>
      <label>Part separation (mm)<input type="number" min="0" max="50" step="1" value={effective.separatorMm} onChange={e => onChange({ ...settings, separatorMm: Number(e.target.value) })} /></label>
      <label>Carton wall (mm)<input type="number" min="0" max="50" step="0.5" value={effective.wallMm} onChange={e => onChange({ ...settings, wallMm: Number(e.target.value) })} /></label>
    </div>
    {error ? <p role="alert">{error}</p> : !estimate ? <p role="status">Calculating packing...</p> : estimate.errors.length ? <ul className="packing-errors" role="alert">{estimate.errors.map(message => <li key={message}>{message}</li>)}</ul> : plan && <>
      <div className="packing-shipment"><strong>{estimate.boxes.length} box{estimate.boxes.length === 1 ? '' : 'es'} / {pieces.length} components</strong><span>{estimate.boxes.reduce((sum, box) => sum + box.volumeLitres, 0).toFixed(1)} litres total outside volume</span></div>
      <div className="packing-table-wrap"><table className="packing-box-table"><thead><tr><th>Box</th><th>Internal size</th><th>Components</th><th>Stock</th></tr></thead><tbody>{estimate.boxes.map((box, i) => <tr key={i}><td>{i + 1}</td><td>{boxSize(box.stockInternal ?? box.internal)}</td><td>{box.layers.reduce((n, l) => n + l.parts.length, 0)}</td><td>{box.stockId ? box.stockQuantity : 'New size required'}</td></tr>)}</tbody></table></div>
      {estimate.boxes.length > 1 && <label className="packing-alternatives">Box<select aria-label="Packing box" value={boxIndex} onChange={e => setChoice(Number(e.target.value))}>{estimate.boxes.map((box, i) => <option key={i} value={i}>Box {i + 1}: {boxSize(box.stockInternal ?? box.internal)}</option>)}</select></label>}
      <div className="packing-summary">
        <div><span>Box {boxIndex + 1} internal size</span><strong>{boxSize(plan.stockInternal ?? plan.internal)}</strong><small>Packing orientation: {boxSize(plan.internal)}</small></div>
        <div><span>{plan.stockId ? 'Stock size' : 'Suggested internal range'}</span><strong className="packing-range">{plan.stockName || `${boxSize(plan.internal)} to ${boxSize(plan.rangeMax)}`}</strong><small>Estimated outside: {boxSize(plan.external)}</small></div>
        <div><span>Packing layers</span><strong>{plan.layers.length}</strong><small>{plan.volumeLitres.toFixed(1)} litres outside volume</small></div>
      </div>
      <ol className="packing-stack-list" aria-label={`Box ${boxIndex + 1} stack bottom to top`}>{plan.layers.map((layer, i) => <li key={layer.parts[0].id}><strong>{i === 0 ? 'Bottom' : i === plan.layers.length - 1 ? 'Top' : `Layer ${i + 1}`}</strong><span>{layer.parts.map(p => pieces.find(piece => piece.id === p.id)?.name).join(', ')}</span><small>{layer.height} mm</small></li>)}</ol>
      <PackingPreview key={`${boxIndex}/${plan.layers.map(layer => layer.parts[0].id).join('/')}`} plan={plan} pieces={pieces} />
    </>}
    <details className="packing-measurements"><summary>Component measurements ({pieces.length})</summary><div className="packing-table-wrap"><table><thead><tr><th>Component</th><th>Length (mm)</th><th>Width (mm)</th><th>Thickness (mm)</th><th>Source</th></tr></thead><tbody>{pieces.map((piece, i) => <tr key={piece.id}><td>{i + 1}. {piece.name}</td><td><input aria-label={`Packing length for ${piece.name}`} type="number" min="0.1" step="0.1" value={piece.width} onChange={e => measurement(piece.id, 'widthMm', e.target.value)} /></td><td><input aria-label={`Packing width for ${piece.name}`} type="number" min="0.1" step="0.1" value={piece.height} onChange={e => measurement(piece.id, 'heightMm', e.target.value)} /></td><td><input aria-label={`Packing thickness for ${piece.name}`} type="number" min="0.1" step="0.1" value={piece.thickness} onChange={e => measurement(piece.id, 'thicknessMm', e.target.value)} /></td><td>{piece.footprintSource} / {piece.thicknessSource}</td></tr>)}</tbody></table></div></details>
    {estimate && <ul className="packing-notes">{estimate.warnings.map(warning => <li key={warning}>{warning}</li>)}<li>Support overhanging edges with protective inserts. Carton construction, hardware and actual fit require a trial pack.</li></ul>}
  </section>
}
