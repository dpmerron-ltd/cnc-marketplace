import { useEffect, useRef, useState } from 'react'
import { Download, FileUp, Save } from 'lucide-react'
import type { MarketplaceItem } from '../models/Item'
import type { CamResult, CamSettings, OperationKind, OperationOverride } from '../cam/types'
import { camPreset } from '../cam/types'
import { materialPreset } from '../cam/generate'
import { downloadText } from '../storage/projectStorage'
import { CamPreview } from './CamPreview'
import { operationColors, operationNames } from './camAppearance'
import './CamPage.css'

const kinds = Object.keys(operationNames) as OperationKind[]
export interface CamSave { itemId: string; filename: string; source: string; gcode: string }

export function CamPage({ items, onSave }: { items: MarketplaceItem[]; onSave: (value: CamSave) => void }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const loadId = useRef(0)
  const [source, setSource] = useState('')
  const [filename, setFilename] = useState('')
  const [settings, setSettings] = useState<CamSettings>({ thickness: 18, units: 'auto', operations: {} })
  const [result, setResult] = useState<CamResult>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [reviewed, setReviewed] = useState(false)
  const [itemId, setItemId] = useState(items[0]?.id ?? '')
  const [saved, setSaved] = useState(false)
  const [view, setView] = useState<'preview' | 'code'>('preview')
  const material = materialPreset(settings.thickness)
  useEffect(() => {
    if (!source) return
    let active = true
    const worker = new Worker(new URL('../cam/worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = event => {
      if (!active) return
      setResult(event.data.result); setError(event.data.error ?? ''); setBusy(false)
    }
    worker.onerror = () => { if (active) { setError('Generation failed. Check the DXF and try again.'); setBusy(false); setResult(undefined) } }
    worker.postMessage({ source, settings })
    return () => { active = false; worker.terminate() }
  }, [source, settings])
  useEffect(() => () => { loadId.current++ }, [])
  function update(patch: Partial<CamSettings>) {
    setReviewed(false); setSaved(false); setBusy(Boolean(source)); setSettings(s => ({ ...s, ...patch }))
  }
  function operation(ids: string[], patch: OperationOverride) {
    const operations = { ...settings.operations }
    for (const id of ids) operations[id] = { ...operations[id], ...patch }
    update({ operations })
  }
  async function upload(file?: File) {
    if (!file) return
    const id = ++loadId.current
    setError(''); setReviewed(false); setResult(undefined); setSaved(false); setBusy(true); setSource(''); setFilename(file.name)
    try {
      if (!/\.dxf$/i.test(file.name)) throw new Error('Choose a DXF file.')
      if (file.size > 2000000) throw new Error('DXF exceeds 2 MB.')
      const text = await file.text()
      if (id !== loadId.current) return
      if (!text.trim()) throw new Error('DXF is empty.')
      setFilename(file.name); setSettings(s => ({ ...s, units: 'auto', operations: {} })); setSelected(undefined); setSource(text)
    } catch (error) { if (id === loadId.current) { setError((error as Error).message); setBusy(false) } }
  }
  const features = result?.drawing.features ?? []
  const layers = [...new Set(features.map(f => f.layer))]
  const problems = [error, ...(result?.errors ?? [])].filter(Boolean)
  const ready = Boolean(result?.gcode) && !busy && !problems.length && reviewed
  const outputName = `${filename.replace(/\.dxf$/i, '') || 'component'}-${settings.thickness}mm.nc`
  return <main className="cam-page">
    <div className="cam-heading"><h2>Generate G-code</h2><span>{filename || 'DXF'}</span><button type="button" className="icon-text-button" onClick={() => fileInput.current?.click()}><FileUp size={17} />Upload DXF</button><input ref={fileInput} className="hidden-file" type="file" accept=".dxf" aria-label="Upload DXF file" onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} /></div>
    <div className="cam-settings">
      <label>Material thickness<select value={settings.thickness} onChange={e => update({ thickness: Number(e.target.value) as 12 | 18 })}><option value="18">18 mm</option><option value="12">12 mm</option></select></label>
      <label>DXF units<select value={settings.units} onChange={e => update({ units: e.target.value as CamSettings['units'] })}><option value="auto">From DXF{result ? ` (${result.drawing.units})` : ''}</option><option value="mm">Millimetres</option><option value="inches">Inches</option></select></label>
      <dl><div><dt>Cutter</dt><dd>6.35 mm</dd></div><div><dt>Spindle</dt><dd>18,000 rpm</dd></div><div><dt>Clearance</dt><dd>20 mm</dd></div><div><dt>Cut depth</dt><dd>{material.depth} mm</dd></div><div><dt>Passes</dt><dd>{material.passes.length} x {settings.thickness === 18 ? '9.2' : '12.2'} mm</dd></div><div><dt>Drill depth</dt><dd>{material.drill} mm</dd></div><div><dt>Ramp</dt><dd>3 deg / 600 mm/min</dd></div><div><dt>Cut feed</dt><dd>3,000 mm/min</dd></div></dl>
    </div>
    <div className="cam-workspace">
      <aside className="cam-operations" aria-label="Machining operations">
        <div className="cam-section-heading"><h3>Operations</h3><span>{features.length}</span></div>
        {!features.length && <div className="cam-empty">{busy ? 'Reading DXF...' : 'No operations'}</div>}
        {layers.map(layer => {
          const group = features.filter(f => f.layer === layer)
          const same = group.every(f => f.kind === group[0].kind)
          return <details key={layer} open className="cam-layer"><summary>{layer}<span>{group.length}</span></summary>
            <label className="cam-layer-kind">Layer operation<select aria-label={`Operation for layer ${layer}`} value={same ? group[0].kind : ''} onChange={e => operation(group.map(f => f.id), { kind: e.target.value as OperationKind })}><option value="" disabled>Mixed</option>{kinds.map(kind => <option key={kind} value={kind}>{operationNames[kind]}</option>)}</select></label>
            {group.map(f => {
              const override = settings.operations[f.id] ?? {}
              return <div key={f.id} className={`cam-operation ${selected === f.id ? 'is-selected' : ''}`}>
                <button type="button" className="cam-operation-name" onClick={() => setSelected(f.id)}><i style={{ backgroundColor: operationColors[f.kind] }} />{f.name}</button>
                <select aria-label={`Operation for ${f.name}`} value={f.kind} onChange={e => operation([f.id], { kind: e.target.value as OperationKind })}>{kinds.map(kind => <option key={kind} value={kind}>{operationNames[kind]}</option>)}</select>
                <div className="cam-operation-fields">
                  {(f.kind === 'inside' || f.kind === 'outside') && <label>Tabs<input aria-label={`Tabs for ${f.name}`} type="number" min="0" max="4" step="1" value={override.tabs ?? 4} onChange={e => operation([f.id], { tabs: Number(e.target.value) })} /></label>}
                  {f.kind === 'pocket' && <label>Depth (mm)<input aria-label={`Pocket depth for ${f.name}`} type="number" min="0.1" max={material.depth} step="0.1" value={override.depthMm ?? f.depthMm ?? material.depth} onChange={e => operation([f.id], { depthMm: Number(e.target.value) })} /></label>}
                  {f.kind === 'drill' ? <span>Hole diameter {camPreset.diameter} mm</span> : f.circle && <span>DXF diameter {(f.circle.radius * 2).toFixed(2)} mm</span>}
                  {f.kind === 'drill' && <span>Depth {material.drill} mm / 2 mm pecks</span>}
                </div>
              </div>
            })}
          </details>
        })}
      </aside>
      <section className="cam-main">
        <div className="cam-section-heading"><div className="cam-view-tabs" role="tablist" aria-label="CAM view"><button type="button" role="tab" aria-selected={view === 'preview'} onClick={() => setView('preview')}>Toolpaths</button><button type="button" role="tab" aria-selected={view === 'code'} onClick={() => setView('code')}>G-code</button></div><span role="status">{busy ? 'Generating...' : result ? `${result.operations.length} operations / ${Math.ceil(result.simulation.estimatedSeconds / 60)} min` : ''}</span></div>
        {view === 'preview' ? <CamPreview result={result} selected={selected} onSelect={setSelected} /> : <textarea className="cam-code" aria-label="Generated G-code" readOnly value={busy ? '' : result?.gcode ?? ''} />}
        {result && <div className="cam-extents"><span>Extent X {result.simulation.bounds.maxX.toFixed(2)} / Y {result.simulation.bounds.maxY.toFixed(2)} mm</span><span>DXF shift X {result.shift.x.toFixed(2)} / Y {result.shift.y.toFixed(2)} mm</span><span>Tabs 10 mm wide / 6 mm above final depth</span></div>}
        {problems.length > 0 && <section className="cam-problems" role="alert"><h3>Export blocked ({problems.length})</h3><ul>{problems.map((message, i) => <li key={i}>{message}</li>)}</ul></section>}
        {!!result?.warnings.length && <details className="cam-warnings"><summary>Review notices ({result.warnings.length})</summary><ul>{result.warnings.map((message, i) => <li key={i}>{message}</li>)}</ul></details>}
      </section>
    </div>
    <footer className="cam-export">
      <label className="cam-review"><input type="checkbox" checked={reviewed} disabled={!result?.gcode || busy} onChange={e => setReviewed(e.target.checked)} />Units, operations, hole sizes, tabs, stock, cutter, origin, clamps and DDCS spindle delay reviewed</label>
      <div className="cam-export-actions"><button type="button" className="primary icon-text-button" disabled={!ready} onClick={() => downloadText(outputName, result!.gcode)}><Download size={17} />Download G-code</button><label>Item<select aria-label="Save generated component to item" value={itemId} onChange={e => { setItemId(e.target.value); setSaved(false) }}><option value="">Select item</option>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="button" className="icon-text-button" disabled={!ready || !items.some(i => i.id === itemId) || saved} onClick={() => { onSave({ itemId, filename: outputName, source, gcode: result!.gcode }); setSaved(true) }}><Save size={17} />{saved ? 'Added to item' : 'Add component'}</button></div>
    </footer>
  </main>
}
