import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { exportCombinedGCode } from './gcode/exporter'
import { createPartFromGCode } from './gcode/importPart'
import { instanceBounds } from './gcode/transform'
import { validateSheet } from './gcode/validator'
import type { MarketplaceItem } from './models/Item'
import type { Part } from './models/Part'
import type { PartInstance } from './models/PartInstance'
import type { Project } from './models/Project'
import type { Sheet } from './models/Sheet'
import { rectsOverlap } from './models/geometry'
import { autoNest } from './nesting/nestingEngine'
import { downloadText, loadProject, saveProject } from './storage/projectStorage'
import { supabase } from './storage/supabaseClient'
import { canUseSupabase, deleteRemoteComponent, loadRemoteProject, saveRemoteProject } from './storage/supabaseProjectStore'
import { GCodeSettings } from './ui/GCodeSettings'
import { LoginPage } from './ui/LoginPage'
import { MarketplacePage } from './ui/MarketplacePage'
import { PartLibrary } from './ui/PartLibrary'
import { PropertiesPanel } from './ui/PropertiesPanel'
import { SheetEditor } from './ui/SheetEditor'

const defaultSheet: Sheet = {
  width: 1220,
  height: 1220,
  spacing: 5,
  instances: [],
  gcodeSettings: {
    startGcode: 'G21\nG17\nG90\nG94',
    endGcode: 'M05\nM30',
    safeZ: 5,
  },
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

function extension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? ''
}

function stem(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').toLowerCase()
}

function newInstance(partId: string, x: number, y: number): PartInstance {
  return {
    id: crypto.randomUUID(),
    partId,
    x,
    y,
    rotation: 0,
    locked: false,
  }
}

function newItem(name = 'Untitled Item'): MarketplaceItem {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    name,
    description: '',
    createdAt: now,
    updatedAt: now,
  }
}

interface AppPersistenceState {
  items: MarketplaceItem[]
  parts: Part[]
  sheet: Sheet
  selectedItemId?: string
  restored: boolean
}

function projectToAppState(project: Project | undefined): AppPersistenceState {
  if (!project) {
    return {
      items: [],
      parts: [],
      sheet: defaultSheet,
      restored: false,
    }
  }

  if (project.items && project.items.length > 0) {
    const fallbackItemId = project.items[0].id
    return {
      items: project.items,
      parts: project.parts.map((part) => ({ ...part, itemId: part.itemId ?? fallbackItemId })),
      sheet: project.sheet,
      selectedItemId: fallbackItemId,
      restored: true,
    }
  }

  const legacyItem = newItem('Imported Components')
  return {
    items: [legacyItem],
    parts: project.parts.map((part) => ({ ...part, itemId: part.itemId ?? legacyItem.id })),
    sheet: project.sheet,
    selectedItemId: legacyItem.id,
    restored: true,
  }
}

function findDuplicatePlacement(part: Part, source: PartInstance, parts: Part[], sheet: Sheet): PartInstance {
  const copy: PartInstance = { ...source, id: crypto.randomUUID() }
  const sourceBounds = instanceBounds(part, source)
  const copySize = {
    width: sourceBounds.maxX - sourceBounds.minX,
    height: sourceBounds.maxY - sourceBounds.minY,
  }
  const placed = sheet.instances
    .map((instance) => {
      const placedPart = parts.find((candidate) => candidate.id === instance.partId)
      return placedPart ? instanceBounds(placedPart, instance) : undefined
    })
    .filter((bounds) => bounds !== undefined)

  function isValid(candidate: PartInstance): boolean {
    const bounds = instanceBounds(part, candidate)
    if (bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > sheet.width || bounds.maxY > sheet.height) return false
    return placed.every((placedBounds) => !rectsOverlap(bounds, placedBounds, sheet.spacing))
  }

  const preferred: PartInstance[] = [
    { ...copy, x: source.x + copySize.width + sheet.spacing, y: source.y },
    { ...copy, x: source.x, y: source.y + copySize.height + sheet.spacing },
  ]

  for (const candidate of preferred) {
    if (isValid(candidate)) return candidate
  }

  const xs = new Set<number>([sheet.spacing])
  const ys = new Set<number>([sheet.spacing])
  for (const bounds of placed) {
    xs.add(bounds.maxX + sheet.spacing)
    xs.add(bounds.minX - copySize.width - sheet.spacing)
    ys.add(bounds.maxY + sheet.spacing)
    ys.add(bounds.minY - copySize.height - sheet.spacing)
  }

  const candidates = [...xs].flatMap((x) => [...ys].map((y) => ({ ...copy, x: Math.max(0, x), y: Math.max(0, y) })))
  candidates.sort((a, b) => Math.hypot(a.x - source.x, a.y - source.y) - Math.hypot(b.x - source.x, b.y - source.y))

  return candidates.find(isValid) ?? { ...copy, x: source.x + sheet.spacing + 10, y: source.y + sheet.spacing + 10 }
}

function App() {
  const initialState = useMemo(() => projectToAppState(loadProject()), [])
  const [page, setPage] = useState<'marketplace' | 'sheet'>('marketplace')
  const [items, setItems] = useState<MarketplaceItem[]>(initialState.items)
  const [parts, setParts] = useState<Part[]>(initialState.parts)
  const [sheet, setSheet] = useState<Sheet>(initialState.sheet)
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(initialState.selectedItemId)
  const [selectedPartId, setSelectedPartId] = useState<string>()
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>()
  const [preview, setPreview] = useState<string>()
  const [status, setStatus] = useState(initialState.restored ? 'Loaded saved marketplace from this browser.' : 'Ready')
  const [authReady, setAuthReady] = useState(!supabase)
  const [userEmail, setUserEmail] = useState<string>()
  const importProjectRef = useRef<HTMLInputElement>(null)
  const remoteHydratedRef = useRef(false)

  const selectedInstance = sheet.instances.find((instance) => instance.id === selectedInstanceId)
  const selectedInstancePart = selectedInstance ? parts.find((part) => part.id === selectedInstance.partId) : undefined
  const selectedItem = items.find((item) => item.id === selectedItemId)
  const visibleParts = selectedItemId ? parts.filter((part) => part.itemId === selectedItemId) : []
  const issues = useMemo(() => validateSheet(parts, sheet), [parts, sheet])
  const errors = issues.filter((issue) => issue.level === 'error')
  const warnings = issues.filter((issue) => issue.level === 'warning')

  useEffect(() => {
    if (!userEmail) return

    const timeout = window.setTimeout(() => {
      saveProject({ version: 1, items, parts, sheet, savedAt: new Date().toISOString() })
      if (remoteHydratedRef.current && canUseSupabase()) {
        void saveRemoteProject(items, parts, sheet, selectedItemId).then((result) => {
          if (!result.ok) setStatus(`Cloud save failed: ${result.error ?? 'unknown error'}`)
        })
      }
    }, 300)

    return () => window.clearTimeout(timeout)
  }, [items, parts, selectedItemId, sheet, userEmail])

  useEffect(() => {
    if (!canUseSupabase() || !userEmail) return

    let cancelled = false
    void loadRemoteProject().then((remoteProject) => {
      remoteHydratedRef.current = true
      if (cancelled || !remoteProject) {
        if (!cancelled) setStatus('Using local browser storage. Run the Supabase schema setup to enable cloud sync.')
        return
      }

      if (remoteProject.items.length > 0 || remoteProject.parts.length > 0 || remoteProject.sheet) {
        setItems(remoteProject.items)
        setParts(remoteProject.parts)
        if (remoteProject.sheet) setSheet(remoteProject.sheet)
        setSelectedItemId(remoteProject.selectedItemId)
        setSelectedInstanceId(undefined)
        setStatus('Loaded marketplace from Supabase.')
      } else {
        setStatus('Connected to Supabase. Marketplace is empty.')
      }
    })

    return () => {
      cancelled = true
    }
  }, [userEmail])

  useEffect(() => {
    if (!supabase) return

    void supabase.auth.getSession().then((result) => {
      setUserEmail(result.data.session?.user.email)
      setAuthReady(true)
    })

    const listener = supabase.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user.email)
      if (!session) {
        remoteHydratedRef.current = false
        setItems([])
        setParts([])
        setSheet(defaultSheet)
        setSelectedItemId(undefined)
        setSelectedPartId(undefined)
        setSelectedInstanceId(undefined)
        setPreview(undefined)
        setStatus('Signed out.')
      }
    })

    return () => {
      listener.data.subscription.unsubscribe()
    }
  }, [])

  async function login(username: string, password: string): Promise<string | undefined> {
    if (!supabase) return 'Supabase is not configured.'

    const result = await supabase.auth.signInWithPassword({
      email: username,
      password,
    })

    if (result.error) return 'Invalid username or password.'
    setStatus('Signed in.')
    return undefined
  }

  async function signOut() {
    saveProject(buildProject())
    if (remoteHydratedRef.current && canUseSupabase()) {
      const result = await saveRemoteProject(items, parts, sheet, selectedItemId)
      if (!result.ok) {
        setStatus(`Sign out blocked. Cloud save failed: ${result.error ?? 'unknown error'}`)
        return
      }
    }

    void supabase?.auth.signOut()
  }

  async function importFilesForItem(itemId: string, fileList: FileList) {
    const files = Array.from(fileList)
    const dxfFiles = files.filter((file) => extension(file.name) === 'dxf')
    const gcodeFiles = files.filter((file) => ['nc', 'tap', 'gcode', 'cnc'].includes(extension(file.name)))
    const dxfByStem = new Map<string, string>()

    for (const file of dxfFiles) {
      dxfByStem.set(stem(file.name), await readFile(file))
    }

    const imported: Part[] = []
    for (const file of gcodeFiles) {
      const gcode = await readFile(file)
      imported.push(createPartFromGCode(file.name, gcode, dxfByStem.get(stem(file.name)), itemId))
    }

    setParts((current) => [...current, ...imported])
    setItems((current) => current.map((item) => (item.id === itemId ? { ...item, updatedAt: new Date().toISOString() } : item)))
    setStatus(imported.length > 0 ? `Imported ${imported.length} component file(s).` : 'No supported G-code files found.')
  }

  function importFiles(fileList: FileList) {
    if (!selectedItemId) {
      const item = newItem('Imported Item')
      setItems((current) => [...current, item])
      setSelectedItemId(item.id)
      void importFilesForItem(item.id, fileList)
      return
    }

    void importFilesForItem(selectedItemId, fileList)
  }

  function createMarketplaceItem() {
    const item = newItem(`Item ${items.length + 1}`)
    setItems((current) => [...current, item])
    setSelectedItemId(item.id)
    setPage('marketplace')
    setStatus('Created new marketplace item.')
  }

  function updateMarketplaceItem(itemId: string, patch: Partial<MarketplaceItem>) {
    setItems((current) => current.map((item) => (item.id === itemId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item)))
  }

  function deleteComponent(partId: string) {
    const isPlaced = sheet.instances.some((instance) => instance.partId === partId)
    if (isPlaced) {
      setStatus('Remove this component from the sheet before deleting it from the item.')
      return
    }

    setParts((current) => current.filter((part) => part.id !== partId))
    void deleteRemoteComponent(partId)
    if (selectedPartId === partId) setSelectedPartId(undefined)
    setStatus('Removed component from item.')
  }

  function addPart(partId: string, x = sheet.spacing, y = sheet.spacing) {
    setSheet((current) => ({
      ...current,
      instances: [...current.instances, newInstance(partId, x, y)],
    }))
  }

  function updateInstance(instanceId: string, patch: Partial<PartInstance>) {
    setSheet((current) => ({
      ...current,
      instances: current.instances.map((instance) => (instance.id === instanceId ? { ...instance, ...patch } : instance)),
    }))
  }

  function duplicateSelected() {
    if (!selectedInstance || !selectedInstancePart) return
    const copy = findDuplicatePlacement(selectedInstancePart, selectedInstance, parts, sheet)
    setSheet((current) => ({ ...current, instances: [...current.instances, copy] }))
    setSelectedInstanceId(copy.id)
    setStatus('Duplicated part at the nearest open position.')
  }

  function deleteSelected() {
    if (!selectedInstanceId) return
    setSheet((current) => ({ ...current, instances: current.instances.filter((instance) => instance.id !== selectedInstanceId) }))
    setSelectedInstanceId(undefined)
  }

  function buildProject(): Project {
    return { version: 1, items, parts, sheet, savedAt: new Date().toISOString() }
  }

  async function saveCurrentProject() {
    const localSaved = saveProject(buildProject())
    if (!localSaved) {
      setStatus('Could not save project; browser storage may be full.')
      return
    }

    if (remoteHydratedRef.current && canUseSupabase()) {
      const remoteSaved = await saveRemoteProject(items, parts, sheet, selectedItemId)
      setStatus(remoteSaved.ok ? 'Saved project to Supabase.' : `Cloud save failed: ${remoteSaved.error ?? 'unknown error'}`)
      return
    }

    setStatus('Saved project to local browser storage.')
  }

  function loadSavedProject() {
    const loadedState = projectToAppState(loadProject())
    if (!loadedState.restored) {
      setStatus('No saved project found in local browser storage.')
      return
    }

    setItems(loadedState.items)
    setSelectedItemId(loadedState.selectedItemId)
    setParts(loadedState.parts)
    setSheet(loadedState.sheet)
    setSelectedInstanceId(undefined)
    setStatus('Loaded saved marketplace from this browser.')
  }

  async function importProject(fileList: FileList | null) {
    const file = fileList?.[0]
    if (!file) return
    const project = JSON.parse(await readFile(file)) as Project
    const importedState = projectToAppState(project)
    setItems(importedState.items)
    setSelectedItemId(importedState.selectedItemId)
    setParts(importedState.parts)
    setSheet(importedState.sheet)
    setSelectedInstanceId(undefined)
    setStatus(`Imported project ${file.name}.`)
  }

  function previewGCode() {
    const result = exportCombinedGCode(parts, sheet)
    setPreview(result.gcode)
    setStatus(result.errors.length > 0 ? `Preview generated with ${result.errors.length} export error(s).` : 'Preview generated from transformed G-code.')
  }

  function exportGCode() {
    if (errors.length > 0) {
      setStatus('Export blocked by validation errors.')
      return
    }

    const result = exportCombinedGCode(parts, sheet)
    if (result.errors.length > 0) {
      setStatus('Export blocked by G-code transformation errors.')
      setPreview(result.gcode)
      return
    }

    downloadText('combined-sheet.nc', result.gcode, 'application/x-gcode')
    setStatus('Exported combined-sheet.nc.')
  }

  if (!authReady) {
    return <main className="login-shell"><div className="login-panel">Loading...</div></main>
  }

  if (!userEmail) {
    return <LoginPage onLogin={login} />
  }

  return (
    <div className="app">
      <header className="toolbar">
        <h1>CNC Marketplace</h1>
        <span className="signed-in">{userEmail}</span>
        <button type="button" onClick={() => void signOut()}>Sign Out</button>
        <button type="button" className={page === 'marketplace' ? 'active-nav' : ''} onClick={() => setPage('marketplace')}>Items</button>
        <button type="button" className={page === 'sheet' ? 'active-nav' : ''} onClick={() => setPage('sheet')}>Sheet</button>
        <label>
          Sheet
          <input type="number" value={sheet.width} onChange={(event) => setSheet({ ...sheet, width: Number(event.target.value) })} />
        </label>
        <span>x</span>
        <label>
          <input type="number" value={sheet.height} onChange={(event) => setSheet({ ...sheet, height: Number(event.target.value) })} />
          mm
        </label>
        <label>
          Spacing
          <input type="number" value={sheet.spacing} onChange={(event) => setSheet({ ...sheet, spacing: Number(event.target.value) })} />
        </label>
        <button type="button" onClick={() => setSheet({ ...sheet, instances: autoNest(parts, sheet) })}>Auto Nest</button>
        <button type="button" onClick={() => void saveCurrentProject()}>Save Sheet</button>
        <button type="button" onClick={loadSavedProject}>Load Sheet</button>
        <button type="button" onClick={previewGCode}>Preview G-code</button>
        <button type="button" className="primary" onClick={exportGCode}>Export G-code</button>
      </header>

      {page === 'marketplace' ? (
        <MarketplacePage
          items={items}
          parts={parts}
          selectedItemId={selectedItemId}
          onCreateItem={createMarketplaceItem}
          onSelectItem={setSelectedItemId}
          onUpdateItem={updateMarketplaceItem}
          onImportComponents={(itemId, files) => void importFilesForItem(itemId, files)}
          onDeleteComponent={deleteComponent}
          onAddToSheet={(partId) => {
            addPart(partId)
            setPage('sheet')
          }}
          onOpenSheet={() => setPage('sheet')}
        />
      ) : (
        <div className="workspace">
          <PartLibrary
            parts={visibleParts}
            title={selectedItem ? selectedItem.name : 'Components'}
            emptyText="Select an item on the Items page, then upload components to add them to the sheet."
            selectedPartId={selectedPartId}
            onImport={importFiles}
            onAdd={addPart}
            onSelect={setSelectedPartId}
          />
          <SheetEditor parts={parts} sheet={sheet} selectedId={selectedInstanceId} onAddPart={addPart} onSelect={setSelectedInstanceId} onUpdateInstance={updateInstance} />
          <div className="side-stack">
            <PropertiesPanel
              part={selectedInstancePart}
              instance={selectedInstance}
              onUpdate={(patch) => selectedInstanceId && updateInstance(selectedInstanceId, patch)}
              onDuplicate={duplicateSelected}
              onDelete={deleteSelected}
            />
            <GCodeSettings settings={sheet.gcodeSettings} onChange={(gcodeSettings) => setSheet({ ...sheet, gcodeSettings })} />
          </div>
        </div>
      )}

      <section className="bottom-bar">
        <div>
          <strong>Status:</strong> {status}
        </div>
        <div className={errors.length > 0 ? 'issue error' : 'issue'}>
          {errors.length} errors
        </div>
        <div className={warnings.length > 0 ? 'issue warning' : 'issue'}>
          {warnings.length} warnings
        </div>
        <button type="button" onClick={() => downloadText('sheet-builder-project.json', JSON.stringify(buildProject(), null, 2), 'application/json')}>Export Project</button>
        <button type="button" onClick={() => importProjectRef.current?.click()}>Import Project</button>
        <input ref={importProjectRef} className="hidden-file" type="file" accept=".json" onChange={(event) => void importProject(event.target.files)} />
      </section>

      {(issues.length > 0 || preview) && (
        <section className="diagnostics">
          {issues.length > 0 && (
            <div className="panel issue-list">
              <h2>Validation</h2>
              <ul>
                {issues.slice(0, 10).map((issue, index) => (
                  <li key={`${issue.message}-${index}`} className={issue.level}>{issue.message}</li>
                ))}
              </ul>
            </div>
          )}
          {preview && (
            <div className="panel preview">
              <div className="panel-header">
                <h2>Combined G-code Preview</h2>
                <button type="button" onClick={() => setPreview(undefined)}>Close</button>
              </div>
              <textarea readOnly value={preview} />
            </div>
          )}
        </section>
      )}
    </div>
  )
}

export default App
