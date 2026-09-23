import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Copy, Download, Play, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react'
import { machineStatusNames, ncHash, type MachineRun, type MachineRunSummary, type MachineStatus } from '../machine/exportSnapshot'
import { changeMachineRunStatus, listMachineRuns, loadMachineRun } from '../storage/machineRunsStore'
import { downloadText } from '../storage/projectStorage'
import './MachinePage.css'

const mm = (value: number) => Number(value.toFixed(2)).toString()
const selectedId = () => window.location.hash.match(/^#machine\/([0-9a-f-]{36})$/i)?.[1]

export function MachinePage({ userId }: { userId: string }) {
  const [id, setId] = useState(selectedId)
  const [runs, setRuns] = useState<MachineRunSummary[]>([])
  const [run, setRun] = useState<MachineRun>()
  const [filter, setFilter] = useState('waiting')
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [sheetIndex, setSheetIndex] = useState(0)
  const [partNumber, setPartNumber] = useState<string>()
  const [zoom, setZoom] = useState(1)
  const [showTabs, setShowTabs] = useState(true)
  const [showScrews, setShowScrews] = useState(true)
  const mapContainer = useRef<HTMLDivElement>(null)
  const [mapWidth, setMapWidth] = useState(600)
  const lifetime = useRef(0)
  useEffect(() => {
    const update = () => setId(selectedId())
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    const epoch = ++lifetime.current
    setLoading(true); setError(''); setRun(undefined); setRuns([]); setCopied(false); setBusy(false)
    setSheetIndex(0); setPartNumber(undefined); setZoom(1)
    void (async () => {
      try {
        if (id) {
          const loaded = await loadMachineRun(userId, id, abort.signal)
          if (!abort.signal.aborted) setRun(loaded)
        } else {
          const loaded = await listMachineRuns(userId, offset, filter, abort.signal)
          if (!abort.signal.aborted) setRuns(loaded)
        }
      } catch (cause) { if (!abort.signal.aborted) setError((cause as Error).message) }
      finally { if (lifetime.current === epoch && !abort.signal.aborted) setLoading(false) }
    })()
    return () => { abort.abort(); lifetime.current++ }
  }, [userId, id, filter, offset, revision])
  useEffect(() => {
    const element = mapContainer.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => setMapWidth(entries[0].contentRect.width || 600))
    observer.observe(element)
    return () => observer.disconnect()
  }, [run])

  function navigate(next?: string) {
    window.location.hash = next ? `machine/${next}` : 'machine'
    setId(next)
  }
  async function action(callback: () => Promise<void>) {
    const epoch = lifetime.current
    setBusy(true); setError('')
    try { await callback() }
    catch (cause) { if (epoch === lifetime.current) setError((cause as Error).message) }
    finally { if (epoch === lifetime.current) setBusy(false) }
  }
  async function transition(status: MachineStatus) {
    if (!run) return
    if (status === 'cancelled' && !window.confirm('Cancel this exported job? This does not stop the machine.')) return
    const epoch = lifetime.current
    await action(async () => {
      await changeMachineRunStatus(userId, run, status)
      if (epoch === lifetime.current) setRun({ ...run, status })
    })
  }
  const snapshot = run?.snapshot
  const map = snapshot?.map
  const sheet = snapshot?.sheets[sheetIndex]
  const parts = map?.parts.filter(part => part.sheetIndex === sheetIndex) ?? []
  const selected = parts.find(part => part.number === partNumber)
  const files = snapshot?.mode === 'combined' ? snapshot.files : snapshot?.files.slice(sheetIndex, sheetIndex + 1) ?? []
  // Keep labels readable at the overview scale, including narrow phone screens.
  const markerSize = map ? map.width * 12 / mapWidth : 10
  const warnings = [...new Set([...(snapshot?.warnings ?? []), ...parts.flatMap(part => part.warnings.map(warning => `${part.number}: ${warning}`))])]

  return <main className="machine-page">
    <header className="machine-heading">
      <div>{id && <button type="button" className="icon-text-button" onClick={() => navigate()}><ArrowLeft size={18} /> Waiting sheets</button>}<h2>{run?.name ?? 'At Machine'}</h2>{run && <p>Order {run.order_number} <span className={`machine-status machine-status-${run.status}`}>{machineStatusNames[run.status]}</span></p>}</div>
      <button type="button" className="icon-button" title="Refresh exported sheets" aria-label="Refresh exported sheets" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={19} /></button>
    </header>
    {error && <p role="alert" className="machine-error">{error}</p>}
    {loading ? <p role="status">Loading exported sheets...</p> : !id ? <>
      <div className="machine-list-controls"><label>Status<select value={filter} onChange={event => { setFilter(event.target.value); setOffset(0) }}><option value="">All exports</option>{Object.entries(machineStatusNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><span>{runs.length} exports</span></div>
      <div className="machine-run-list">{runs.map(entry => <button type="button" key={entry.id} className="machine-run" onClick={() => navigate(entry.id)}><div><strong>{entry.name}</strong><span className={`machine-status machine-status-${entry.status}`}>{machineStatusNames[entry.status]}</span></div><span>Order {entry.order_number} · {entry.thickness} · {entry.material}</span><span>{entry.sheet_count} sheet{entry.sheet_count === 1 ? '' : 's'} · {entry.part_count} parts</span><small>{new Date(entry.created_at).toLocaleString()}</small></button>)}</div>
      {!error && !runs.length && <p>No exported sheets {filter === 'waiting' ? 'waiting to cut' : 'found'}.</p>}
      <div className="machine-pagination"><button type="button" className="icon-button" title="Previous exports" aria-label="Previous exports" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}><ChevronLeft size={20} /></button><span>Page {offset / 25 + 1}</span><button type="button" className="icon-button" title="Next exports" aria-label="Next exports" disabled={runs.length < 25} onClick={() => setOffset(offset + 25)}><ChevronRight size={20} /></button></div>
    </> : run && snapshot && map && sheet ? <>
      <dl className="machine-facts"><div><dt>Stock thickness</dt><dd>{snapshot.thickness}</dd></div><div><dt>Material</dt><dd>{snapshot.material}</dd></div><div><dt>Bed / sheet</dt><dd>{mm(map.width)} × {mm(map.height)} mm</dd></div><div><dt>Deepest cut</dt><dd>{snapshot.deepestCutMm == null ? 'Not identified' : `${mm(snapshot.deepestCutMm)} mm`}</dd></div><div><dt>Clearance Z</dt><dd>{mm(snapshot.safeZ)} mm</dd></div><div><dt>Reach check X / Y</dt><dd>{mm(sheet.maxX)} / {mm(sheet.maxY)} mm</dd></div></dl>
      <section className="machine-bed-section" aria-label="Exported bed layout">
        <div className="machine-bed-controls"><label>Physical sheet<select aria-label="Physical sheet" value={sheetIndex} onChange={event => { setSheetIndex(Number(event.target.value)); setPartNumber(undefined); setZoom(1) }}>{snapshot.sheets.map(value => <option value={value.index} key={value.index}>Sheet {value.index + 1} of {map.sheetCount}</option>)}</select></label><div><button type="button" className="icon-button" title="Zoom out" aria-label="Zoom out" disabled={zoom === 1} onClick={() => setZoom(value => Math.max(1, value - 0.5))}><ZoomOut size={20} /></button><button type="button" className="icon-button" title="Zoom in" aria-label="Zoom in" disabled={zoom === 4} onClick={() => setZoom(value => Math.min(4, value + 0.5))}><ZoomIn size={20} /></button></div></div>
        <div className="machine-map-scroll" ref={mapContainer}><svg aria-label={`Sheet ${sheetIndex + 1} cutting paths and tab locations`} role="img" className="machine-map" viewBox={`${-markerSize * 2} ${-markerSize * 2} ${map.width + markerSize * 4} ${map.height + markerSize * 4}`} style={{ width: `${zoom * 100}%` }}>
          <rect x="0" y="0" width={map.width} height={map.height} fill="#fff" stroke="#6b7280" strokeWidth={markerSize / 6} />
          <g transform={`translate(0 ${map.height}) scale(1 -1)`}>
            <path d={`M0,0 H${sheet.maxX} V${sheet.maxY} H0 Z`} fill="none" stroke="#64748b" strokeDasharray={`${markerSize} ${markerSize}`} strokeWidth={markerSize / 8} />
            {parts.map((part, index) => <g key={part.number} opacity={selected && selected.number !== part.number ? 0.3 : 1} onClick={() => setPartNumber(part.number)}>
              <rect x={part.bounds.minX} y={part.bounds.minY} width={part.bounds.maxX - part.bounds.minX} height={part.bounds.maxY - part.bounds.minY} fill={selected?.number === part.number ? '#dbeafe' : 'transparent'} stroke="none" />
              {part.paths.map((path, i) => <polyline key={i} points={path.map(point => `${point.x},${point.y}`).join(' ')} stroke={index % 2 ? '#5c4794' : '#1769aa'} strokeWidth={markerSize / 5} strokeLinecap="round" fill="none" />)}
              {showTabs && part.tabs.map((tab, i) => <g key={i}><polyline points={tab.points.map(point => `${point.x},${point.y}`).join(' ')} stroke="#b96c00" strokeWidth={markerSize * 0.7} fill="none" /><circle cx={tab.center.x} cy={tab.center.y} r={markerSize * 0.65} fill="#fff3ca" stroke="#805200" strokeWidth={markerSize / 8} /><text x={0} y={0} transform={`translate(${tab.center.x} ${tab.center.y}) scale(1 -1)`} textAnchor="middle" dominantBaseline="central" fontSize={markerSize * 0.85} fill="#422d00">{i + 1}</text></g>)}
              <text transform={`translate(${(part.bounds.minX + part.bounds.maxX) / 2} ${(part.bounds.minY + part.bounds.maxY) / 2}) scale(1 -1)`} textAnchor="middle" dominantBaseline="central" fontSize={markerSize * 1.3} fill="#111827" stroke="#fff" strokeWidth={markerSize / 5} paintOrder="stroke">{part.number}</text>
            </g>)}
            {showScrews && sheet.screws.map((point, index) => <path key={index} d={`M${point.x - markerSize / 2},${point.y - markerSize / 2} l${markerSize},${markerSize} m0,-${markerSize} l-${markerSize},${markerSize}`} stroke="#111827" strokeWidth={markerSize / 5} />)}
          </g>
          <text x="0" y={map.height + markerSize * 1.6} fontSize={markerSize} fill="#111827">X0 Y0</text>
          <text x={map.width} y={map.height + markerSize * 1.6} textAnchor="end" fontSize={markerSize} fill="#111827">X {mm(map.width)}</text>
          <text x="0" y={-markerSize * 0.6} fontSize={markerSize} fill="#111827">Y {mm(map.height)}</text>
        </svg></div>
        <div className="machine-map-legend"><label><input type="checkbox" checked={showTabs} onChange={event => setShowTabs(event.target.checked)} /><span className="machine-tab-key" /> Tabs ({parts.reduce((sum, part) => sum + part.tabs.length, 0)})</label><label><input type="checkbox" checked={showScrews} onChange={event => setShowScrews(event.target.checked)} /> × Screw marks ({sheet.screws.length})</label><span>Dashed: reach extent</span></div>
      </section>
      <section className="machine-parts"><h3>Parts on sheet {sheetIndex + 1}</h3><div className="machine-part-list">{parts.map(part => <button type="button" key={part.number} aria-label={`${part.number} ${part.name} ${part.tabs.length} tabs`} aria-pressed={selected?.number === part.number} onClick={() => setPartNumber(selected?.number === part.number ? undefined : part.number)}><strong>{part.number}</strong><span>{part.name}</span><small>{part.tabs.length} tabs</small></button>)}</div>
        {selected && <div className="machine-part-detail"><h4>{selected.number} · {selected.name}</h4><p>Rotation {mm(selected.rotation)}° · Bounds X {mm(selected.bounds.minX)}–{mm(selected.bounds.maxX)}, Y {mm(selected.bounds.minY)}–{mm(selected.bounds.maxY)} mm</p>{selected.tabs.length > 0 && <table><thead><tr><th>Tab</th><th>X</th><th>Y</th><th>Z</th></tr></thead><tbody>{selected.tabs.map((tab, index) => <tr key={index}><td>{index + 1}{tab.inferred ? '*' : ''}</td><td>{mm(tab.center.x)}</td><td>{mm(tab.center.y)}</td><td>{mm(tab.z)}</td></tr>)}</tbody></table>}</div>}
      </section>
      <section className="machine-files"><h3>Exported program</h3><p>{snapshot.mode === 'combined' && map.sheetCount > 1 ? `Combined file: ${map.sheetCount} physical sheets, with a load-sheet pause between them.` : `Separate program for sheet ${sheetIndex + 1}.`}</p>{files.map(file => <div className="machine-file" key={file.filename}><strong>{file.filename}</strong><span>Estimated file time: {Math.ceil(file.estimatedSeconds / 60)} min, excluding operator pauses</span><button type="button" className="icon-text-button" disabled={busy} onClick={() => { const epoch = lifetime.current; void action(async () => { if (await ncHash(file.gcode) !== file.sha256) throw new Error('Saved file integrity check failed. Do not run this file.'); if (epoch === lifetime.current) downloadText(file.filename, file.gcode, 'application/x-gcode') }) }}><Download size={18} /> Download NC</button><details><summary>File fingerprint (SHA-256)</summary><code>{file.sha256}</code></details></div>)}<p>Exported {new Date(run.created_at).toLocaleString()} · Reference {run.id.slice(0, 8)}</p><button type="button" className="icon-text-button" disabled={busy} onClick={() => void action(async () => { await navigator.clipboard.writeText(window.location.href); setCopied(true) })}>{copied ? <Check size={18} /> : <Copy size={18} />}{copied ? 'Link copied' : 'Copy sheet link'}</button></section>
      <section className="machine-setup"><h3>Program setup</h3><p>Z0 is the material surface. Origin X0 Y0 is shown at the lower-left of the layout.</p><p>{sheet.screws.length ? `${sheet.screws.length} screw marks, 2 mm deep, followed by a stop for fitting recessed screws.` : 'No screw marking on this sheet.'}</p><details><summary>Saved start / spindle / end programs</summary><h4>Start</h4><pre>{snapshot.programs.startGcode}</pre><h4>Spindle start</h4><pre>{snapshot.programs.spindleStartGcode || 'Manual spindle start'}</pre><h4>End</h4><pre>{snapshot.programs.endGcode}</pre></details></section>
      {warnings.length > 0 && <details className="machine-warnings" open><summary>Checks and warnings ({warnings.length})</summary><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      <p className="machine-caution">Match the NC filename and stock before running. This layout is not a machine safety check; verify workholding, tooling, origin and clearance at the machine.</p>
      <div className="machine-actions">{run.status === 'waiting' && <button type="button" className="primary icon-text-button" disabled={busy} onClick={() => void transition('cutting')}><Play size={18} /> Mark cutting</button>}{run.status === 'cutting' && <button type="button" className="primary icon-text-button" disabled={busy} onClick={() => void transition('completed')}><Check size={18} /> Mark completed</button>}{['waiting', 'cutting'].includes(run.status) && <button type="button" disabled={busy} onClick={() => void transition('cancelled')}>Cancel export</button>}<small>Status only; does not control the CNC. Applies to all {map.sheetCount} sheet{map.sheetCount === 1 ? '' : 's'} in this export.</small></div>
    </> : null}
  </main>
}
