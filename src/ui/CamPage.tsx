import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, Download, FileUp, Save, SkipForward, TriangleAlert } from 'lucide-react'
import type { MarketplaceItem } from '../models/Item'
import type { CamResult, CamSettings, OperationKind, OperationOverride } from '../cam/types'
import { camPreset, cutterWidthOpening, defaultTabCount, requiresHoldingTabs, tabFreeOpening } from '../cam/types'
import { materialPreset } from '../cam/generate'
import { downloadText } from '../storage/projectStorage'
import { CamPreview } from './CamPreview'
import { operationNames } from './camAppearance'
import { CamOperationSwatch } from './CamOperationSwatch'
import './CamPage.css'
import { spindleRpm, type ProgramSettings } from '../gcode/programSettings'
import { materialProfileId, materialProfiles, type MaterialVariants } from '../cam/materialProfiles'
import type { ComponentSaveJob } from './useComponentSaveQueue'

const kinds = Object.keys(operationNames) as OperationKind[]
export interface CamSave { id: string; itemId: string; filename: string; source: string; gcode: string; materialVariants: MaterialVariants }
interface QueuedDxf { file: File; status: 'pending' | 'confirmed' | 'skipped' }

export function CamPage({ items, onSave, programs, saveJobs = [] }: { items: MarketplaceItem[]; onSave: (value: CamSave) => void; programs: ProgramSettings; saveJobs?: ComponentSaveJob[] }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const loadId = useRef(0)
  const confirming = useRef(false)
  const [queue, setQueue] = useState<QueuedDxf[]>([])
  const [fileIndex, setFileIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const [componentId, setComponentId] = useState(() => crypto.randomUUID())
  const [actionError, setActionError] = useState('')
  const [source, setSource] = useState('')
  const [filename, setFilename] = useState('')
  const [settings, setSettings] = useState<CamSettings>({ thickness: 18, units: 'auto', operations: {} })
  const [result, setResult] = useState<CamResult>()
  const [materialVariants, setMaterialVariants] = useState<MaterialVariants>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [reviewed, setReviewed] = useState(false)
  const [itemId, setItemId] = useState(items[0]?.id ?? '')
  const [saved, setSaved] = useState(false)
  const [view, setView] = useState<'preview' | 'code'>('preview')
  const material = materialPreset(settings.thickness, settings.profilePasses, settings.drillDepthMm)
  useEffect(() => {
    if (!source) return
    let active = true
    const id = loadId.current
    const worker = new Worker(new URL('../cam/worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = event => {
      if (!active || id !== loadId.current) return
      setResult(event.data.result); setMaterialVariants(event.data.materialVariants); setError(event.data.error ?? ''); setBusy(false)
    }
    worker.onerror = () => { if (active && id === loadId.current) { setError('Generation failed. Check the DXF and try again.'); setBusy(false); setResult(undefined); setMaterialVariants(undefined) } }
    worker.postMessage({ source, settings: { ...settings, programs } })
    return () => { active = false; worker.terminate() }
  }, [source, settings, programs])
  useEffect(() => () => { loadId.current++ }, [])
  function update(patch: Partial<CamSettings>) {
    if (confirming.current) return
    setComponentId(crypto.randomUUID())
    setReviewed(false); setSaved(false); setBusy(Boolean(source)); setSettings(s => ({ ...s, ...patch }))
  }
  function operation(ids: string[], patch: OperationOverride) {
    const operations = { ...settings.operations }
    for (const id of ids) {
      operations[id] = { ...operations[id], ...patch }
      const feature = features.find(feature => feature.id === id)
      if (patch.kind && feature && tabFreeOpening({ ...feature, ...patch })) operations[id].tabs = 0
      else if (patch.kind && feature && tabFreeOpening(feature)) operations[id].tabs = undefined
    }
    update({ operations })
  }
  async function loadFile(file: File) {
    const id = ++loadId.current
    setMaterialVariants(undefined)
    setComponentId(crypto.randomUUID())
    setError(''); setActionError(''); setReviewed(false); setResult(undefined); setSaved(false); setBusy(true); setSource(''); setFilename(file.name); setSelected(undefined); setView('preview')
    setSettings(s => ({ ...s, units: 'auto', operations: {} }))
    heading.current?.focus({ preventScroll: true })
    window.scrollTo({ top: 0 })
    try {
      if (!/\.dxf$/i.test(file.name)) throw new Error('Choose a DXF file.')
      if (file.size > 2000000) throw new Error('DXF exceeds 2 MB.')
      const text = await file.text()
      if (id !== loadId.current) return
      if (!text.trim()) throw new Error('DXF is empty.')
      setSource(text)
    } catch (error) { if (id === loadId.current) { setError((error as Error).message); setBusy(false) } }
  }
  function upload(files: File[]) {
    if (!files.length || confirming.current) return
    const added: QueuedDxf[] = files.map(file => ({ file, status: 'pending' }))
    if (queue[fileIndex]?.status === 'pending') {
      setQueue(current => [...current, ...added])
    } else {
      setQueue(added); setFileIndex(0); void loadFile(files[0])
    }
  }
  function advance(status: 'confirmed' | 'skipped') {
    setQueue(current => current.map((entry, index) => index === fileIndex ? { ...entry, status } : entry))
    // Keep the existing single-file download/add workflow; batches advance immediately.
    if (queue.length === 1 && status === 'confirmed') return
    const next = fileIndex + 1
    setFileIndex(next)
    if (queue[next]) void loadFile(queue[next].file)
    else {
      loadId.current++
      setMaterialVariants(undefined)
      setSource(''); setResult(undefined); setFilename(''); setError(''); setActionError(''); setBusy(false); setReviewed(false); setSelected(undefined)
      heading.current?.focus({ preventScroll: true })
      window.scrollTo({ top: 0 })
    }
  }
  const features = result?.drawing.features ?? []
  const layers = [...new Set(features.map(f => f.layer))]
  const problems = [error, ...(result?.errors ?? [])].filter(Boolean)
  const ready = Boolean(result?.gcode) && !busy && !saving && !problems.length && reviewed
  const outputName = `${filename.replace(/\.dxf$/i, '') || 'component'}-${settings.thickness}mm${settings.drillDepthMm !== undefined ? `-${settings.drillDepthMm}mm-holes` : settings.profilePasses === 2 ? '-2pass' : ''}.nc`
  const batch = queue.length > 1
  const currentFile = queue[fileIndex]
  const complete = queue.length > 0 && queue.every(entry => entry.status !== 'pending')
  const saveStatus = saveJobs.find(job => job.id === componentId)?.status
  const savedLabel = saveStatus === 'saved' ? 'Added to item' : saveStatus === 'failed' ? 'Save failed' : saveStatus ? 'Queued for saving' : 'Confirmed'
  function confirm(action: 'download' | 'save') {
    if (!ready || confirming.current || action === 'save' && (saved || !items.some(item => item.id === itemId))) return
    confirming.current = true
    setSaving(true); setActionError('')
    const id = loadId.current
    try {
      if (action === 'save') {
        if (!materialVariants) throw new Error('Material variants have not finished generating. Try generating again.')
        onSave({ id: componentId, itemId, filename: outputName, source, gcode: result!.gcode, materialVariants })
      }
      else downloadText(outputName, result!.gcode)
      if (id !== loadId.current) return
      if (action === 'save') { setSaved(true); advance('confirmed') }
    } catch (error) {
      if (id === loadId.current) setActionError(error instanceof Error ? error.message : 'Unable to confirm this file. Try again.')
    } finally { confirming.current = false; setSaving(false) }
  }
  return <main className="cam-page">
    <div className="cam-heading"><h2 ref={heading} tabIndex={-1}>Generate G-code</h2><span>{filename || 'DXF'}</span><button type="button" className="icon-text-button" disabled={saving} onClick={() => fileInput.current?.click()}><FileUp size={17} />{currentFile?.status === 'pending' ? 'Add DXFs' : 'Upload DXFs'}</button><input ref={fileInput} className="hidden-file" type="file" accept=".dxf" multiple disabled={saving} aria-label="Upload DXF files" onChange={e => { upload(Array.from(e.target.files ?? [])); e.target.value = '' }} /></div>
    {batch && <section className="cam-queue" aria-label="DXF queue">
      <div className="cam-queue-heading"><span role="status">{complete ? 'Queue complete' : `File ${fileIndex + 1} of ${queue.length}`}</span><span>{queue.filter(entry => entry.status === 'confirmed').length} confirmed / {queue.filter(entry => entry.status === 'skipped').length} skipped</span>{currentFile?.status === 'pending' && <button type="button" className="icon-text-button" disabled={saving} onClick={() => advance('skipped')}><SkipForward size={16} />Skip file</button>}</div>
      <details><summary>{complete ? 'Processed files' : 'Queued files'}</summary><ol>{queue.map((entry, index) => <li key={index} aria-current={index === fileIndex && entry.status === 'pending' ? 'step' : undefined}><span>{index + 1}. {entry.file.name}</span><span>{entry.status === 'confirmed' ? <><Check size={14} />Confirmed</> : entry.status === 'skipped' ? 'Skipped' : index === fileIndex ? 'In review' : 'Waiting'}</span></li>)}</ol></details>
    </section>}
    <div className="cam-settings">
      <label>Material thickness<select value={materialProfileId(settings.thickness, settings.profilePasses, settings.drillDepthMm)} onChange={e => {
        const profile = materialProfiles.find(profile => profile.id === e.target.value)!
        update({ thickness: profile.thickness, profilePasses: profile.thickness === 12 && profile.profilePasses === 2 ? 2 : undefined, drillDepthMm: profile.drillDepthMm })
      }}>{[...materialProfiles].reverse().map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>
      <label>DXF units<select value={settings.units} onChange={e => update({ units: e.target.value as CamSettings['units'] })}><option value="auto">From DXF{result ? ` (${result.drawing.units})` : ''}</option><option value="mm">Millimetres</option><option value="inches">Inches</option></select></label>
      <dl><div><dt>Cutter</dt><dd>6.35 mm</dd></div><div><dt>Spindle</dt><dd>{programs.spindleStartGcode.trim() ? `${spindleRpm(programs).toLocaleString()} rpm` : 'Manual control'}</dd></div><div><dt>Clearance</dt><dd>20 mm</dd></div><div><dt>Cut depth</dt><dd>{material.depth} mm</dd></div><div><dt>Passes</dt><dd>{material.passes.length} x {material.passes[0]} mm</dd></div><div><dt>Drill depth</dt><dd>{material.drill} mm</dd></div><div><dt>Ramp</dt><dd>3 deg / 600 mm/min</dd></div><div><dt>Cut feed</dt><dd>3,000 mm/min</dd></div></dl>
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
                <button type="button" className="cam-operation-name" aria-pressed={selected === f.id} onClick={() => setSelected(f.id)}><CamOperationSwatch kind={f.kind} />{f.name}</button>
                <select aria-label={`Operation for ${f.name}`} value={f.kind} onChange={e => operation([f.id], { kind: e.target.value as OperationKind })}>{kinds.map(kind => <option key={kind} value={kind}>{operationNames[kind]}</option>)}</select>
                <div className="cam-operation-fields">
                  {(f.kind === 'inside' || f.kind === 'outside') && <label>Tabs<input aria-label={`Tabs for ${f.name}`} type="number" min={requiresHoldingTabs(f) ? 1 : 0} max={tabFreeOpening(f) ? 0 : 4} disabled={tabFreeOpening(f)} step="1" value={tabFreeOpening(f) || result?.operations.find(op => op.featureId === f.id)?.tabs.length === 0 ? 0 : override.tabs ?? defaultTabCount(f)} onChange={e => operation([f.id], { tabs: Number(e.target.value) })} /></label>}
                  {cutterWidthOpening(f) && <span>{camPreset.diameter} mm cutter-width hole</span>}
                  {f.kind === 'pocket' && <label>Depth (mm)<input aria-label={`Pocket depth for ${f.name}`} type="number" min="0.1" max={settings.thickness - 0.1} step="0.1" value={override.depthMm ?? f.depthMm ?? ''} onChange={e => operation([f.id], { depthMm: Number(e.target.value) })} /></label>}
                  {!f.circle && (f.kind === 'pocket' || f.kind === 'inside') && <label><input type="checkbox" aria-label={`Corner overcuts for ${f.name}`} checked={override.cornerOvercuts ?? true} onChange={e => operation([f.id], { cornerOvercuts: e.target.checked })} />Corner overcuts</label>}
                  {f.kind === 'drill' ? <span>Hole diameter {camPreset.diameter} mm</span> : f.circle && <span>DXF diameter {(f.circle.radius * 2).toFixed(2)} mm</span>}
                  {f.kind === 'drill' && <span>Depth {material.drill} mm / 2 mm pecks</span>}
                  {f.hinge && <span>35 mm hinge pocket / 15 or 18 mm stock</span>}
                </div>
              </div>
            })}
          </details>
        })}
      </aside>
      <section className="cam-main">
        <div className="cam-section-heading"><div className="cam-view-tabs" role="tablist" aria-label="CAM view"><button type="button" role="tab" aria-selected={view === 'preview'} onClick={() => setView('preview')}>Toolpaths</button><button type="button" role="tab" aria-selected={view === 'code'} onClick={() => setView('code')}>G-code</button></div><span role="status">{busy ? 'Generating...' : result ? `${result.operations.length} operations / ${Math.ceil(result.simulation.estimatedSeconds / 60)} min` : ''}</span></div>
        {view === 'preview' ? <CamPreview key={`${fileIndex}:${filename}`} result={result} selected={selected} onSelect={setSelected} /> : <textarea className="cam-code" aria-label="Generated G-code" readOnly value={busy ? '' : result?.gcode ?? ''} />}
        {result && <div className="cam-extents"><span>Extent X {result.simulation.bounds.maxX.toFixed(2)} / Y {result.simulation.bounds.maxY.toFixed(2)} mm</span><span>DXF shift X {result.shift.x.toFixed(2)} / Y {result.shift.y.toFixed(2)} mm</span><span>Tabs 10 mm wide / 6 mm above final depth</span></div>}
        {problems.length > 0 && <section className="cam-problems" role="alert"><h3><CircleAlert size={16} aria-hidden="true" />Export blocked ({problems.length})</h3><ul>{problems.map((message, i) => <li key={i}>{message}</li>)}</ul></section>}
        {!!result?.warnings.length && <details className="cam-warnings"><summary><TriangleAlert size={15} aria-hidden="true" />Review notices ({result.warnings.length})</summary><ul>{result.warnings.map((message, i) => <li key={i}>{message}</li>)}</ul></details>}
        {!busy && materialVariants && <details className="cam-warnings"><summary>Material variants</summary><ul>{materialProfiles.map(profile => <li key={profile.id}>{profile.label}: {!materialVariants.profiles[profile.id] ? 'Unavailable: regenerate this component' : materialVariants.profiles[profile.id]!.errors.length ? `Unavailable: ${materialVariants.profiles[profile.id]!.errors.join(' ')}` : 'Generated'}</li>)}</ul></details>}
      </section>
    </div>
    <footer className="cam-export">
      <label className="cam-review"><input type="checkbox" checked={reviewed} disabled={!result?.gcode || busy || saving || problems.length > 0} onChange={e => setReviewed(e.target.checked)} />Units, operations, hole sizes, tabs, stock, cutter, origin, clamps and DDCS spindle delay reviewed</label>
      {actionError && <p className="cam-action-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{actionError}</p>}
      <div className="cam-export-actions"><button type="button" className={`${batch ? '' : 'primary '}icon-text-button`} disabled={!ready} onClick={() => void confirm('download')}><Download size={17} />Download G-code</button><label>Item<select aria-label="Save generated component to item" disabled={saving} value={itemId} onChange={e => { setItemId(e.target.value); setSaved(false); setComponentId(crypto.randomUUID()) }}><option value="">Select item</option>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="button" className={`${batch ? 'primary ' : ''}icon-text-button`} disabled={!ready || !items.some(i => i.id === itemId) || saved} onClick={() => void confirm('save')}><Save size={17} />{saving ? 'Confirming...' : saved ? savedLabel : batch ? 'Confirm & add component' : 'Add component'}</button></div>
    </footer>
  </main>
}
