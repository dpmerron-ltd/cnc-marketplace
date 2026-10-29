import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type { SetStateAction } from 'react'
import { newWorkspace, newProductionJob, removeProductionJob, today, updateProductionSheet, waitingExportSheet, sheetIndices, waitingSheetIndices, sheetSignature, changeSheetStage, type SheetWorkspace, type ProductionJob, type SheetStage } from './jobs/production'
import { sheetGCodeFilename } from './gcode/filenames'
import { cacheWorkspace, recoveryWorkspace } from './storage/workspaceCache'
import { reserveExportName } from './storage/exportNamesStore'
import { replanWaiting } from './jobs/replanWaiting'
import { CuttingJobsPage } from './ui/CuttingJobsPage'
import { completeSheetRecuts } from './storage/machineRecutsStore'
import type { MachineRecut } from './machine/recuts'
import { Download, Trash2, UserRound } from 'lucide-react'
import { ProfilePage } from './ui/ProfilePage'
import { loadProgramSettings, saveProgramSettings } from './storage/programSettingsStore'
import type { ProgramSettings } from './gcode/programSettings'
import { numberSheetParts } from './labels/partLabels'
import { PartLabelsDialog } from './ui/PartLabelsDialog'
import { TabMapDownload } from './ui/TabMapDownload'
import { QueuePage } from './ui/QueuePage'
import { MachinePage } from './ui/MachinePage'
import { buildExportSnapshot } from './machine/exportSnapshot'
import { loadMachineRun, saveMachineRun } from './storage/machineRunsStore'
import { OrdersPage } from './ui/OrdersPage'
import { nestOrder, prepareOrderSheet, type AddOrderRequest, type NestProgress } from './orders/addOrderToSheet'
import { BoxStockPage } from './ui/BoxStockPage'
import { originalFinalDepth } from './gcode/depth'
import { exportCombinedGCode, exportPhysicalSheetGCodes } from './gcode/exporter'
import { createPartFromGCode } from './gcode/importPart'
import { simulateGCode } from './gcode/simulator'
import { planScrewPositions } from './gcode/screwPositions'
import { defaultSafeZOverrideMm, effectiveSafeZ } from './gcode/safeZ'
import type { GCodeSimulation } from './gcode/simulator'
import { instanceBounds } from './gcode/transform'
import { validateSheet } from './gcode/validator'
import type { MarketplaceItem } from './models/Item'
import { catalogueItems, defaultItem, editableItem, itemFamily } from './models/itemVersions'
import { mergeVersionEdit, subscribeCatalogueChanges } from './storage/catalogueChanges'
import { itemImageSchema, type ItemImage } from './models/ItemImage'
import type { ComponentSummary, Part } from './models/Part'
import { summarizePart } from './models/Part'
import { cutSideLabel, sheetCutSide, compatibleCutSides, type CutSide } from './models/cutSide'
import type { PartInstance } from './models/PartInstance'
import type { Project, SheetHistoryEntry } from './models/Project'
import type { GCodePreset, Sheet } from './models/Sheet'
import { footprintsOverlap, instanceFootprint, polygonBounds } from './gcode/footprint'
import { AutoNestButton } from './ui/AutoNestButton'
import { addItemToSheet } from './nesting/addItemToSheet'
import { downloadText, loadProject, saveProject } from './storage/projectStorage'
import { copyProjectToAccount, privateProject } from './storage/accountProject'
import { supabase } from './storage/supabaseClient'
import {
  canUseSupabase,
  deleteRemoteComponent,
  deleteRemoteSheetHistory,
  loadRemoteProject,
  loadRemoteItemComponents,
  saveRemoteComponent,
  saveRemoteCutSide,
  saveRemoteItemImage,
  saveRemoteProject,
  saveRemoteSheetHistory,
} from './storage/supabaseProjectStore'
import { GCodeSimulationPanel } from './ui/GCodeSimulationPanel'
import { HistoryPage } from './ui/HistoryPage'
import { LoginPage } from './ui/LoginPage'
import { MarketplacePage } from './ui/MarketplacePage'
import { MfaPage } from './ui/MfaPage'
import type { MfaEnrollment } from './ui/MfaPage'
import { PartLibrary } from './ui/PartLibrary'
import { PropertiesPanel } from './ui/PropertiesPanel'
import { SheetEditor } from './ui/SheetEditor'
import type { CamSave } from './ui/CamPage'
import { useComponentSaveQueue } from './ui/useComponentSaveQueue'
import { ComponentSaveQueue } from './ui/ComponentSaveQueue'
import { materialProfiles, materialVariantsSchema, type MaterialProfileId } from './cam/materialProfiles'
import { selectMaterialParts } from './gcode/materialSelection'

const CamPage = lazy(() => import('./ui/CamPage').then(module => ({ default: module.CamPage })))
const PrintablesPage = lazy(() => import('./ui/PrintablesPage').then(module => ({ default: module.PrintablesPage })))
const pageFromHash = () => window.location.hash.startsWith('#machine') ? 'machine' as const : window.location.hash === '#queue' || window.location.hash.startsWith('#queue/') ? 'queue' as const : window.location.hash === '#prints' ? 'prints' as const : 'marketplace' as const

const defaultSheet: Sheet = {
  name: today(),
  width: 1220,
  height: 1220,
  spacing: 30,
  borderSpacing: 10,
  instances: [],
  screwMarkingEnabled: true,
  safeZOverrideMm: defaultSafeZOverrideMm,
  gcodeSettings: {
    startGcode: 'G21\nG17\nG90\nG94',
    spindleStartGcode: 'S18000\nM03',
    endGcode: 'M05\nM30',
    safeZ: 5,
  },
  gcodePresets: [
    {
      id: 'default-estlcam-mm',
      name: 'Estlcam metric',
      settings: {
        startGcode: 'G21\nG17\nG90\nG94',
        spindleStartGcode: 'S18000\nM03',
        endGcode: 'M05\nM30',
        safeZ: 5,
      },
    },
  ],
  defaultGcodePresetId: 'default-estlcam-mm',
}

function normalizeGCodeSettings(rawSettings: Partial<Sheet['gcodeSettings']> | undefined): Sheet['gcodeSettings'] {
  const raw = rawSettings ?? {}
  return {
    startGcode: raw.startGcode ?? defaultSheet.gcodeSettings.startGcode,
    spindleStartGcode: raw.spindleStartGcode ?? defaultSheet.gcodeSettings.spindleStartGcode,
    endGcode: raw.endGcode ?? defaultSheet.gcodeSettings.endGcode,
    safeZ: raw.safeZ ?? defaultSheet.gcodeSettings.safeZ,
  }
}

function normalizeSheet(sheet: Sheet): Sheet {
  const gcodeSettings = normalizeGCodeSettings(sheet.gcodeSettings)
  const presets = sheet.gcodePresets && sheet.gcodePresets.length > 0 ? sheet.gcodePresets : defaultSheet.gcodePresets
  const normalizedPresets = presets?.map((preset) => ({ ...preset, settings: normalizeGCodeSettings(preset.settings) }))

  return numberSheetParts({
    ...defaultSheet,
    ...sheet,
    name: sheet.name?.trim() || defaultSheet.name,
    screwMarkingEnabled: sheet.screwMarkingEnabled ?? defaultSheet.screwMarkingEnabled,
    safeZOverrideMm: sheet.safeZOverrideMm === undefined ? defaultSafeZOverrideMm : sheet.safeZOverrideMm,
    instances: sheet.instances.map((instance) => ({ ...instance, sheetIndex: instance.sheetIndex ?? 0 })),
    gcodeSettings,
    gcodePresets: normalizedPresets,
    defaultGcodePresetId: sheet.defaultGcodePresetId ?? defaultSheet.defaultGcodePresetId,
  })
}

function pruneMissingSheetInstances(sheet: Sheet, availableParts: { id: string }[]): Sheet {
  const partIds = new Set(availableParts.map((part) => part.id))
  return {
    ...sheet,
    instances: sheet.instances.filter((instance) => partIds.has(instance.partId)),
  }
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

function skuBase(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function shortCode(): string {
  return crypto.randomUUID().slice(0, 6).toUpperCase()
}

function makeItemSku(name: string): string {
  return `${skuBase(name) || 'ITEM'}-${shortCode()}`
}

function makeComponentSku(itemSku: string, index: number): string {
  return `${skuBase(itemSku) || 'ITEM'}-C${String(index).padStart(3, '0')}`
}

function normalizeItem(item: MarketplaceItem): MarketplaceItem {
  return {
    ...item,
    uploadedBy: item.uploadedBy,
    sku: item.sku || makeItemSku(item.name),
    image: itemImageSchema.safeParse(item.image).success ? item.image : undefined,
  }
}

function normalizePart(part: Part, itemSku?: string, index = 0): Part {
  return {
    ...part,
    sku: part.sku || makeComponentSku(itemSku ?? 'COMP', index + 1),
  }
}

function mergePresets(current: GCodePreset[] | undefined, shared: GCodePreset[]): GCodePreset[] {
  const byId = new Map<string, GCodePreset>()
  for (const preset of current ?? []) byId.set(preset.id, preset)
  for (const preset of shared) byId.set(preset.id, preset)
  return [...byId.values()]
    .map((preset) => ({ ...preset, settings: normalizeGCodeSettings(preset.settings) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function sheetCountFor(sheet: Sheet): number {
  return Math.max(1, ...sheet.instances.map((instance) => instance.sheetIndex + 1))
}

function formatSetting(value: number | undefined, suffix = ''): string {
  if (value === undefined || !Number.isFinite(value)) return 'Not set'
  return `${Number.isInteger(value) ? value : Number(value.toFixed(3))}${suffix}`
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'
  const rounded = Math.round(seconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const remainingSeconds = rounded % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`
  return `${remainingSeconds}s`
}

function formatDistance(mm: number): string {
  if (!Number.isFinite(mm)) return '0 mm'
  if (mm >= 1000) return `${(mm / 1000).toFixed(2)} m`
  return `${mm.toFixed(1)} mm`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeSimulateGCode(source: string): GCodeSimulation {
  try {
    return simulateGCode(source)
  } catch (error) {
    return {
      moves: [],
      bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
      totalDistanceMm: 0,
      cuttingDistanceMm: 0,
      rapidDistanceMm: 0,
      estimatedSeconds: 0,
      deepestCutMm: 0,
      warnings: [],
      errors: [`Simulator failed: ${errorMessage(error)}`],
    }
  }
}

function deepestSourceCut(parts: Part[], sheet: Sheet): number | undefined {
  let deepest: number | undefined
  for (const instance of sheet.instances) {
    const part = parts.find((candidate) => candidate.id === instance.partId)
    if (!part) continue
    const partDepth = originalFinalDepth(part)
    if (partDepth === undefined) continue
    deepest = deepest === undefined ? partDepth : Math.max(deepest, partDepth)
  }
  return deepest
}

function newInstance(partId: string, x: number, y: number, sheetIndex: number): PartInstance {
  return {
    id: crypto.randomUUID(),
    partId,
    sheetIndex,
    x,
    y,
    rotation: 0,
    locked: false,
  }
}

function newItem(name = 'Untitled Item', uploadedBy?: string, ownerId?: string): MarketplaceItem {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  return {
    id,
    version: { familyId: id, number: 1, status: 'published', isDefault: true },
    uploadedBy,
    ownerId,
    sku: makeItemSku(name),
    name,
    description: '',
    createdAt: now,
    updatedAt: now,
  }
}

interface AppPersistenceState {
  workspace?: SheetWorkspace
  items: MarketplaceItem[]
  parts: Part[]
  sheet: Sheet
  sheetHistory: SheetHistoryEntry[]
  selectedItemId?: string
  restored: boolean
}

interface MfaFactor {
  id: string
  factor_type: string
  status: string
  friendly_name?: string
}

interface PendingExportFile {
  sheetIndices: number[]
  filename: string
  gcode: string
  simulation: GCodeSimulation
}

interface ExportSummary {
  sheetName: string
  physicalSheets: number
  placedParts: number
  uniqueComponents: number
  deepestCutMm?: number
  safeZ: number
  estimatedCuttingTimeSeconds: number
  simulatedDistanceMm: number
  simulationErrors: number
  simulationWarnings: number
  reachCheckEnabled: boolean
  screwMarkCount: number
  spindleStartEnabled: boolean
  validationErrors: number
  validationWarnings: number
  exportWarnings: string[]
}

interface PendingExport {
  id: string
  jobId: string
  revision: number
  mode: 'combined' | 'sheets'
  files: PendingExportFile[]
  summary: ExportSummary
  tabMap: { parts: Part[]; sheet: Sheet }
}

function projectToAppState(project: Project | undefined): AppPersistenceState {
  if (!project) {
    return {
      items: [],
      parts: [],
      sheet: defaultSheet,
      sheetHistory: [],
      restored: false,
    }
  }

  if (project.items) {
    const items = project.items.map(normalizeItem)
    const fallbackItemId = items[0]?.id
    const itemSkuById = new Map(items.map((item) => [item.id, item.sku]))
    const partSequenceByItem = new Map<string, number>()
    const parts = project.parts.map((part) => {
      const itemId = part.itemId ?? fallbackItemId
      const nextIndex = (partSequenceByItem.get(itemId) ?? 0) + 1
      partSequenceByItem.set(itemId, nextIndex)
      return normalizePart({ ...part, itemId }, itemSkuById.get(itemId), nextIndex - 1)
    })
    return {
      items,
      parts,
      sheet: pruneMissingSheetInstances(normalizeSheet(project.sheet), [...parts, ...(project.componentIndex ?? [])]),
      sheetHistory: project.sheetHistory ?? [],
      selectedItemId: fallbackItemId,
      restored: true,
      workspace: project.workspace,
    }
  }

  const legacyItem = newItem('Imported Components')
  const parts = project.parts.map((part, index) => normalizePart({ ...part, itemId: part.itemId ?? legacyItem.id }, legacyItem.sku, index))
  return {
    items: [legacyItem],
    parts,
    sheet: pruneMissingSheetInstances(normalizeSheet(project.sheet), parts),
    sheetHistory: project.sheetHistory ?? [],
    selectedItemId: legacyItem.id,
    restored: true,
  }
}

function findDuplicatePlacement(part: Part, source: PartInstance, parts: Part[], sheet: Sheet): PartInstance {
  const copy: PartInstance = { ...source, id: crypto.randomUUID(), partNumber: undefined }
  const sourceBounds = instanceBounds(part, source)
  const copySize = {
    width: sourceBounds.maxX - sourceBounds.minX,
    height: sourceBounds.maxY - sourceBounds.minY,
  }
  const placed = sheet.instances
    .map((instance) => {
      const placedPart = parts.find((candidate) => candidate.id === instance.partId)
      if (instance.sheetIndex !== source.sheetIndex) return undefined
      return placedPart ? instanceFootprint(placedPart, instance) : undefined
    })
    .filter((bounds) => bounds !== undefined)

  function isValid(candidate: PartInstance): boolean {
    const bounds = instanceBounds(part, candidate)
    if (bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > sheet.width || bounds.maxY > sheet.height) return false
    return placed.every(footprint => !footprintsOverlap(instanceFootprint(part, candidate), footprint, sheet.spacing))
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
  for (const footprint of placed) {
    const bounds = polygonBounds(footprint)
    xs.add(bounds.maxX + sheet.spacing)
    xs.add(bounds.minX - copySize.width - sheet.spacing)
    ys.add(bounds.maxY + sheet.spacing)
    ys.add(bounds.minY - copySize.height - sheet.spacing)
  }

  const candidates = [...xs].flatMap((x) => [...ys].map((y) => ({ ...copy, sheetIndex: source.sheetIndex, x: Math.max(0, x), y: Math.max(0, y) })))
  candidates.sort((a, b) => Math.hypot(a.x - source.x, a.y - source.y) - Math.hypot(b.x - source.x, b.y - source.y))

  return candidates.find(isValid) ?? { ...copy, x: source.x + sheet.spacing + 10, y: source.y + sheet.spacing + 10 }
}

function App() {
  const initialState = useMemo(() => projectToAppState(undefined), [])
  const [navigationHash, setNavigationHash] = useState(() => window.location.hash)
  const [page, setPage] = useState<'marketplace' | 'sheet' | 'history' | 'queue' | 'generate' | 'profile' | 'orders' | 'boxes' | 'machine' | 'prints'>(pageFromHash)
  useEffect(() => {
    const navigate = () => { setNavigationHash(window.location.hash); const next = pageFromHash(); if (next !== 'marketplace') setPage(next) }
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])
  const [items, setItems] = useState<MarketplaceItem[]>(initialState.items)
  const [parts, setParts] = useState<Part[]>(initialState.parts)
  const [componentIndex, setComponentIndex] = useState<ComponentSummary[]>([])
  const [componentLoads, setComponentLoads] = useState<Record<string, { state: 'idle' | 'loading' | 'loaded' | 'error'; error?: string }>>({})
  const [componentRetry, setComponentRetry] = useState(0)
  const [exportingProject, setExportingProject] = useState(false)
  const componentEpoch = useRef(0)
  const loadedItems = useRef(new Set<string>())
  const loadingItems = useRef(new Map<string, Promise<Part[]>>())
  const [workspace, replaceWorkspace] = useState<SheetWorkspace>(() => newWorkspace(normalizeSheet(initialState.sheet)))
  const [workspaceSaveError, setWorkspaceSaveError] = useState('')
  const [recoverableWorkspace, setRecoverableWorkspace] = useState<SheetWorkspace>()
  const [savedWorkspaceAt, setSavedWorkspaceAt] = useState('')
  const workspaceRef = useRef(workspace)
  function setWorkspace(value: SetStateAction<SheetWorkspace>) {
    const updated = typeof value === 'function' ? value(workspaceRef.current) : value
    const next = { ...updated, updatedAt: new Date().toISOString() }
    workspaceRef.current = next
    replaceWorkspace(next)
  }
  const activeJob = workspace.jobs.find(job => job.id === workspace.activeId) ?? workspace.jobs[0]
  const sheet = activeJob.sheet
  const planningSheet = { ...sheet, unavailableSheetIndices: sheetIndices(sheet).filter(index => activeJob.sheets[index]?.stage && activeJob.sheets[index].stage !== 'waiting') }
  function setSheet(value: SetStateAction<Sheet>) {
    const current = workspaceRef.current
    const job = current.jobs.find(job => job.id === current.activeId)!
    try {
      const next = updateProductionSheet(job, typeof value === 'function' ? value(job.sheet) : value)
      setWorkspace({ ...current, jobs: current.jobs.map(job => job.id === next.id ? next : job) })
    } catch (error) { setStatus(errorMessage(error)) }
  }
  function openJob(id: string) {
    setWorkspace(current => ({ ...current, activeId: id }))
    setActiveSheetIndex(0); setSelectedInstanceId(undefined)
    setPreview(undefined); setPreviewSimulation(undefined); setPendingExport(undefined)
    setPage('sheet')
  }
  function addJob() {
    const job = newProductionJob({ ...defaultSheet, materialProfile: sheet.materialProfile, material: sheet.material, name: today() })
    setWorkspace(current => ({ activeId: job.id, jobs: [...current.jobs, job] }))
    setActiveSheetIndex(0); setSelectedInstanceId(undefined); setPendingExport(undefined); setPage('sheet')
  }
  function removeJob(id: string) {
    if (exportBusyRef.current || loadedAccountId !== userId) return
    const current = workspaceRef.current
    const job = current.jobs.find(job => job.id === id)
    if (!job || job.archived) return
    const waiting = waitingExportSheet(job).instances.length
    if (waiting && !window.confirm(`Remove job ${job.name} and its ${waiting} waiting part${waiting === 1 ? '' : 's'}? Queued re-cuts will be available to add again. Previous exports and cut-sheet records will be kept.`)) return
    try {
      const next = removeProductionJob(current, id)
      setWorkspace(next)
      if (next.activeId !== current.activeId) { setActiveSheetIndex(0); setSelectedInstanceId(undefined) }
      setPreview(undefined); setPreviewSimulation(undefined); setPendingExport(undefined)
      setStatus(`Job removed.${current.jobs.some(job => job.id === next.activeId) ? '' : ' A fresh empty job is ready.'}`)
    } catch (error) { setStatus(errorMessage(error)) }
  }
  const [activeSheetIndex, setActiveSheetIndex] = useState(0)
  const [sheetHistory, setSheetHistory] = useState<SheetHistoryEntry[]>(initialState.sheetHistory)
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(initialState.selectedItemId)
  const [selectedPartId, setSelectedPartId] = useState<string>()
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>()
  const [preview, setPreview] = useState<string>()
  const [previewSimulation, setPreviewSimulation] = useState<GCodeSimulation>()
  const [pendingExport, setPendingExport] = useState<PendingExport>()
  const [exportBusy, setExportBusy] = useState(false)
  const exportBusyRef = useRef(false)
  const [exportError, setExportError] = useState('')
  const [labelsOpen, setLabelsOpen] = useState(false)
  const [status, setStatus] = useState(initialState.restored ? 'Loaded saved marketplace from this browser.' : 'Ready')
  const [authReady, setAuthReady] = useState(!supabase)
  const [mfaReady, setMfaReady] = useState(!supabase)
  const [mfaMode, setMfaMode] = useState<'enroll' | 'challenge'>('enroll')
  const [mfaFactors, setMfaFactors] = useState<MfaFactor[]>([])
  const [mfaEnrollment, setMfaEnrollment] = useState<MfaEnrollment>()
  const [mfaError, setMfaError] = useState<string>()
  const [mfaBusy, setMfaBusy] = useState(false)
  const [userId, setUserId] = useState<string>()
  const [userEmail, setUserEmail] = useState<string>()
  const importProjectRef = useRef<HTMLInputElement>(null)
  const remoteHydratedRef = useRef(false)
  const accountRef = useRef<string | undefined>(undefined)
  const orderSheetInputs = useRef({ sheet, parts, items, componentIndex })
  orderSheetInputs.current = { sheet, parts, items, componentIndex }
  const [loadedAccountId, setLoadedAccountId] = useState<string>()
  const [libraryLoadError, setLibraryLoadError] = useState<string>()
  const [libraryReload, setLibraryReload] = useState(0)
  const persistedComponentIds = useRef(new Set<string>())
  const [programState, setProgramState] = useState<{ ownerId?: string; programs?: ProgramSettings; loading: boolean; error?: string }>({ loading: true })
  const [programReload, setProgramReload] = useState(0)
  const programs = programState.ownerId === userId && !programState.loading && !programState.error ? programState.programs : undefined
  const programSheet = programs ? { ...sheet, gcodeSettings: { ...sheet.gcodeSettings, ...programs } } : sheet
  const componentSaves = useComponentSaveQueue(userId, persistGeneratedComponent)

  useEffect(() => subscribeCatalogueChanges(change => {
    if (accountRef.current !== change.userId) return
    const current = orderSheetInputs.current
    const local = current.items.find(item => item.id === change.current.id) ?? current.items.find(item => item.id === change.previous?.id)
    const nextItem = mergeVersionEdit(change, local)
    const nextItems = current.items.filter(item => item.id !== nextItem.id && item.id !== change.previous?.id).map(item => itemFamily(item) === itemFamily(nextItem) && item.version ? { ...item, version: { ...item.version, isDefault: false } } : item)
    if (change.previous) nextItems.push(change.previous)
    nextItems.push(nextItem)
    const copies = change.components.flatMap(summary => {
      const source = change.parts.find(part => part.id === summary.id) ?? current.parts.find(part => part.id === summary.id || part.id === summary.sourceId)
      return source ? [{ ...source, ...summary, itemId: nextItem.id }] : []
    })
    const nextParts = [...new Map([...current.parts, ...copies].map(part => [part.id, part])).values()]
    const nextIndex = [...new Map([...current.componentIndex, ...change.components].map(part => [part.id, part])).values()]
    const ready = change.components.every(summary => nextParts.some(part => part.id === summary.id))
    if (ready) loadedItems.current.add(nextItem.id)
    for (const part of change.components) persistedComponentIds.current.add(part.id)
    orderSheetInputs.current = { ...current, items: nextItems, parts: nextParts, componentIndex: nextIndex }
    setItems(nextItems); setParts(nextParts); setComponentIndex(nextIndex)
    setComponentLoads(states => ({ ...states, [nextItem.id]: { state: ready ? 'loaded' : 'idle' } }))
    setSelectedItemId(id => id === change.previous?.id ? nextItem.id : id)
  }), [])

  function resetComponentLoading(nextItems: MarketplaceItem[] = [], loadedIds: string[] = []) {
    componentEpoch.current++
    loadedItems.current = new Set(loadedIds)
    loadingItems.current.clear()
    setComponentLoads(Object.fromEntries(nextItems.map(item => [item.id, { state: loadedIds.includes(item.id) ? 'loaded' : 'idle' }])))
    setExportingProject(false)
  }

  const ensureItemComponents = useCallback((itemId: string): Promise<Part[]> => {
    const current = orderSheetInputs.current
    const item = current.items.find(item => item.id === itemId)
    if (!item || !userId || accountRef.current !== userId) return Promise.reject(new Error('This item is not available in the shared catalogue.'))
    if (loadedItems.current.has(itemId)) return Promise.resolve(current.parts.filter(part => part.itemId === itemId))
    const pending = loadingItems.current.get(itemId)
    if (pending) return pending
    const epoch = componentEpoch.current
    const active = () => epoch === componentEpoch.current && accountRef.current === userId
    setComponentLoads(states => ({ ...states, [itemId]: { state: 'loading' } }))
    const task = (async () => {
      try {
        const fetched = await loadRemoteItemComponents(item, userId)
        if (!active()) throw new Error('Your account or catalogue changed. Try again.')
        const latest = orderSheetInputs.current
        const combined = [...new Map([...fetched, ...latest.parts].map(part => [part.id, part])).values()]
        const known = new Set(combined.map(part => part.id))
        if (latest.componentIndex.some(part => part.itemId === itemId && !known.has(part.id))) throw new Error('Some components are no longer available. Refresh the catalogue before continuing; your sheet has not been changed.')
        for (const part of fetched) persistedComponentIds.current.add(part.id)
        loadedItems.current.add(itemId)
        orderSheetInputs.current = { ...latest, parts: combined }
        setParts(combined)
        setComponentLoads(states => ({ ...states, [itemId]: { state: 'loaded' } }))
        return combined.filter(part => part.itemId === itemId)
      } catch (error) {
        if (active()) setComponentLoads(states => ({ ...states, [itemId]: { state: 'error', error: errorMessage(error) } }))
        throw error
      } finally { if (active()) loadingItems.current.delete(itemId) }
    })()
    loadingItems.current.set(itemId, task)
    return task
  }, [userId])

  const catalogueComponents = useMemo(() => [...new Map<ComponentSummary['id'], ComponentSummary>([...componentIndex, ...parts.map(summarizePart)].map(part => [part.id, part])).values()], [componentIndex, parts])
  const sheetReady = sheet.instances.every(instance => parts.some(part => part.id === instance.partId))
  const requiredSheetItems = JSON.stringify([...new Set([
    ...sheet.instances.flatMap(instance => { const part = catalogueComponents.find(part => part.id === instance.partId); return part?.itemId ? [part.itemId] : [] }),
    ...(selectedItemId ? [selectedItemId] : []),
  ])])
  useEffect(() => {
    if (page !== 'sheet' || !userId || loadedAccountId !== userId) return
    let cancelled = false
    void (async () => {
      for (const id of JSON.parse(requiredSheetItems) as string[]) {
        if (cancelled) return
        await ensureItemComponents(id)
      }
    })().catch(error => { if (!cancelled && accountRef.current === userId) setStatus(errorMessage(error)) })
    return () => { cancelled = true }
  }, [page, userId, loadedAccountId, requiredSheetItems, componentRetry, ensureItemComponents])
  const sheetLoadError = (JSON.parse(requiredSheetItems) as string[]).map(id => componentLoads[id]?.error).find(Boolean)

  useEffect(() => {
    if (!userId || !mfaReady) return
    let active = true
    void loadProgramSettings(userId).then(value => {
      if (active && accountRef.current === userId) setProgramState({ ownerId: userId, programs: value, loading: false })
    }).catch(error => {
      if (active && accountRef.current === userId) setProgramState({ ownerId: userId, loading: false, error: errorMessage(error) })
    })
    return () => { active = false }
  }, [userId, mfaReady, programReload])

  function reloadAccountPrograms() {
    setProgramState({ ownerId: userId, loading: true })
    setProgramReload(value => value + 1)
  }

  async function saveAccountPrograms(value: ProgramSettings) {
    if (!userId) throw new Error('Sign in before saving settings.')
    const saved = await saveProgramSettings(userId, value)
    if (accountRef.current !== userId) return
    setProgramState({ ownerId: userId, programs: saved, loading: false })
    setPreview(undefined); setPreviewSimulation(undefined); setPendingExport(undefined)
  }

  function requirePrograms() {
    if (programs) return true
    setStatus('Configure your CNC program settings in User Profile before exporting.')
    setPage('profile')
    return false
  }

  const sheetParts = useMemo(() => selectMaterialParts(parts, sheet).parts, [parts, sheet])
  const selectedInstance = sheet.instances.find((instance) => instance.id === selectedInstanceId)
  const selectedInstancePart = selectedInstance ? sheetParts.find((part) => part.id === selectedInstance.partId) : undefined
  const selectedItem = items.find((item) => item.id === selectedItemId)
  const visibleParts = selectedItemId ? sheetParts.filter((part) => part.itemId === selectedItemId) : []
  const sheetCount = sheetCountFor(sheet)
  const currentSheetIndex = Math.min(activeSheetIndex, sheetCount - 1)
  const issues = useMemo(() => sheetReady ? validateSheet(parts, sheet) : [], [parts, sheet, sheetReady])
  const errors = issues.filter((issue) => issue.level === 'error')
  const warnings = issues.filter((issue) => issue.level === 'warning')

  function canEditItem(item?: MarketplaceItem): boolean {
    return Boolean(userId && item && editableItem(item))
  }

  async function requireAuthSession(): Promise<boolean> {
    if (!supabase) return false
    const sessionResult = await supabase.auth.getSession()
    if (sessionResult.data.session) {
      if (sessionResult.data.session.user.id !== accountRef.current) return false
      setUserId(sessionResult.data.session.user.id)
      setUserEmail(sessionResult.data.session.user.email)
      return true
    }

    setMfaReady(false)
    setMfaMode('enroll')
    setMfaFactors([])
    setMfaEnrollment(undefined)
    setMfaError('Your login session expired before 2FA setup. Please sign in again.')
    setUserId(undefined)
    setUserEmail(undefined)
    return false
  }

  async function refreshMfaState(): Promise<boolean> {
    if (!supabase) return true
    const accountId = accountRef.current
    const hasSession = await requireAuthSession()
    if (!hasSession) return false

    const [aalResult, factorsResult] = await Promise.all([
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.mfa.listFactors(),
    ])
    if (accountRef.current !== accountId) return false

    if (aalResult.error) {
      setMfaReady(false)
      setMfaMode('challenge')
      setMfaError(aalResult.error.message)
      return false
    }

    const verifiedTotpFactors = ((factorsResult.data?.totp ?? []) as MfaFactor[]).filter((factor) => factor.status === 'verified')
    setMfaFactors(verifiedTotpFactors)
    setMfaEnrollment(undefined)

    if (aalResult.data.currentLevel === 'aal2') {
      setMfaReady(true)
      setMfaError(undefined)
      return true
    }

    setMfaReady(false)
    setMfaMode(verifiedTotpFactors.length > 0 ? 'challenge' : 'enroll')
    setMfaError(factorsResult.error?.message)
    return false
  }

  async function startMfaEnrollment() {
    if (!supabase) return
    const client = supabase
    setMfaBusy(true)
    setMfaError(undefined)
    const hasSession = await requireAuthSession()
    if (!hasSession) {
      setMfaBusy(false)
      return
    }

    const factorsResult = await client.auth.mfa.listFactors()
    if (factorsResult.error) {
      setMfaBusy(false)
      if (factorsResult.error.message.toLowerCase().includes('session')) {
        setMfaError('Your login session expired before 2FA setup. Please sign in again.')
        setUserId(undefined)
        setUserEmail(undefined)
        return
      }
      setMfaError(factorsResult.error.message)
      return
    }

    const staleTotpFactors = ((factorsResult.data?.all ?? []) as MfaFactor[]).filter(
      (factor) => factor.factor_type === 'totp' && factor.status === 'unverified',
    )

    for (const factor of staleTotpFactors) {
      await client.auth.mfa.unenroll({ factorId: factor.id })
    }

    let result = await client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Microsoft Authenticator',
    })

    if (result.error?.message.toLowerCase().includes('friendly name')) {
      result = await client.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `Microsoft Authenticator ${new Date().toISOString().slice(0, 19)}`,
      })
    }

    setMfaBusy(false)

    if (result.error || !result.data) {
      setMfaError(result.error?.message ?? 'Could not start two-factor setup.')
      return
    }

    setMfaEnrollment({
      factorId: result.data.id,
      qrCode: result.data.totp.qr_code,
      secret: result.data.totp.secret,
    })
  }

  async function verifyMfaCode(code: string) {
    if (!supabase) return
    const client = supabase
    const factorId = mfaEnrollment?.factorId ?? mfaFactors[0]?.id
    if (!factorId) {
      setMfaError('No authenticator factor is available.')
      return
    }

    setMfaBusy(true)
    setMfaError(undefined)
    const result = mfaEnrollment
      ? await client.auth.mfa.challenge({ factorId }).then(async (challengeResult) => {
          if (challengeResult.error || !challengeResult.data) return { error: challengeResult.error ?? new Error('Could not create MFA challenge.') }
          return client.auth.mfa.verify({ factorId, challengeId: challengeResult.data.id, code })
        })
      : await client.auth.mfa.challengeAndVerify({ factorId, code })
    setMfaBusy(false)

    if (result.error) {
      setMfaError(result.error.message)
      return
    }

    await refreshMfaState()
    setStatus('Two-factor authentication verified.')
  }

  useEffect(() => {
    if (!userId || loadedAccountId !== userId || !mfaReady) return

    cacheWorkspace(userId, workspace)
    const timeout = window.setTimeout(() => {
      if (accountRef.current !== userId) return
      saveProject({ version: 1, items, parts, componentIndex: catalogueComponents, sheet, workspace, sheetHistory, savedAt: new Date().toISOString() }, userId)
      if (remoteHydratedRef.current && canUseSupabase()) {
        const newParts = parts.filter(part => !persistedComponentIds.current.has(part.id))
        void saveRemoteProject(items, newParts, sheet, selectedItemId, userId, workspace).then((result) => {
          if (accountRef.current !== userId) return
          if (result.ok) {
            for (const part of newParts) persistedComponentIds.current.add(part.id)
            if (workspaceRef.current.updatedAt === workspace.updatedAt) { setSavedWorkspaceAt(workspace.updatedAt ?? ''); setWorkspaceSaveError('') }
          } else { setWorkspaceSaveError(result.error ?? 'Cloud save failed'); setStatus(`Cloud save failed: ${result.error ?? 'unknown error'}`) }
        }).catch(error => { if (accountRef.current === userId) setWorkspaceSaveError(errorMessage(error)) })
      }
    }, 300)

    return () => window.clearTimeout(timeout)
  }, [items, parts, catalogueComponents, selectedItemId, sheet, workspace, sheetHistory, userId, loadedAccountId, mfaReady])

  useEffect(() => {
    if (!canUseSupabase() || !userId || !mfaReady) return

    let cancelled = false
    remoteHydratedRef.current = false
    setLoadedAccountId(undefined)
    resetComponentLoading()
    setLibraryLoadError(undefined)
    setStatus('Loading shared items…')
    void loadRemoteProject(userId, message => {
      if (!cancelled && accountRef.current === userId) setStatus(message)
    }).then((remoteProject) => {
      if (cancelled || accountRef.current !== userId) return
      if (!remoteProject) throw new Error('Your account library could not be loaded. Please retry.')
      remoteHydratedRef.current = true
      const index = remoteProject.componentIndex ?? remoteProject.parts
      persistedComponentIds.current = new Set([...index, ...remoteProject.parts].map(part => part.id))
      const project = privateProject({ version: 1, ...remoteProject, sheet: remoteProject.sheet ?? defaultSheet, savedAt: new Date().toISOString() }, userId)
      const loaded = projectToAppState(project)
      setRecoverableWorkspace(recoveryWorkspace(userId))
      setComponentIndex(project.componentIndex ?? loaded.parts)
      // An unindexed historical version is not an empty, already-loaded item.
      resetComponentLoading(loaded.items, loaded.items.filter(item => loaded.parts.some(part => part.itemId === item.id) && index.filter(part => part.itemId === item.id).every(summary => loaded.parts.some(part => part.id === summary.id))).map(item => item.id))
      setItems(loaded.items)
      setParts(loaded.parts)
      setSheetHistory(loaded.sheetHistory)
      const restoredSheet = pruneMissingSheetInstances({ ...loaded.sheet, gcodePresets: mergePresets(loaded.sheet.gcodePresets, remoteProject?.gcodePresets ?? []) }, [...loaded.parts, ...index])
      setWorkspace(project.workspace?.jobs.length ? { ...project.workspace, jobs: project.workspace.jobs.map(job => ({ ...job, sheet: normalizeSheet(job.sheet) })) } : newWorkspace(restoredSheet))
      setSelectedItemId(loaded.items.some((item) => item.id === remoteProject?.selectedItemId) ? remoteProject?.selectedItemId : loaded.selectedItemId)
      setSelectedInstanceId(undefined)
      setActiveSheetIndex(0)
      setLoadedAccountId(userId)
      setStatus('Loaded the shared item library.')
    }).catch(error => {
      if (cancelled || accountRef.current !== userId) return
      remoteHydratedRef.current = false
      setLibraryLoadError(errorMessage(error))
    })

    return () => {
      cancelled = true
    }
  }, [userId, mfaReady, libraryReload])

  useEffect(() => {
    if (!supabase) return

    const listener = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUserId = session?.user.id
      if (accountRef.current !== nextUserId || !session) {
        accountRef.current = nextUserId
        remoteHydratedRef.current = false
        setLoadedAccountId(undefined)
        persistedComponentIds.current.clear()
        resetComponentLoading()
        setComponentIndex([])
        setLibraryLoadError(undefined)
        setProgramState({ loading: true })
        setMfaReady(false)
        setMfaMode('enroll')
        setMfaFactors([])
        setMfaEnrollment(undefined)
        setMfaError(undefined)
        setItems([])
        setParts([])
        setSheetHistory([])
        setWorkspace(newWorkspace({ ...defaultSheet, name: today() })); setWorkspaceSaveError(''); setSavedWorkspaceAt(''); setRecoverableWorkspace(undefined)
        setActiveSheetIndex(0)
        setSelectedItemId(undefined)
        setSelectedPartId(undefined)
        setSelectedInstanceId(undefined)
        setPreview(undefined)
        setPreviewSimulation(undefined)
        setPendingExport(undefined)
        setLabelsOpen(false)
        setPage(pageFromHash())
        setStatus(session ? 'Loading your account...' : 'Signed out.')
      }
      setUserId(nextUserId)
      setUserEmail(session?.user.email)
      setAuthReady(true)
      // Supabase auth calls must run outside the auth-state callback's lock.
      if (session) window.setTimeout(() => { if (accountRef.current === nextUserId) void refreshMfaState() }, 0)
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
    await refreshMfaState()
    return undefined
  }

  async function signOut() {
    if (componentSaves.pending && !window.confirm('Some components have not saved. Signing out will discard queued and failed saves. Sign out anyway?')) return
    if (userId && loadedAccountId === userId) saveProject(buildProject(), userId)
    if (userId && loadedAccountId === userId && remoteHydratedRef.current && canUseSupabase()) {
      const newParts = parts.filter(part => !persistedComponentIds.current.has(part.id))
      const result = await saveRemoteProject(items, newParts, sheet, selectedItemId, userId, workspace)
      if (accountRef.current !== userId) return
      if (!result.ok) {
        setStatus(`Sign out blocked. Cloud save failed: ${result.error ?? 'unknown error'}`)
        return
      }
    }

    void supabase?.auth.signOut()
  }

  async function importFilesForItem(itemId: string, fileList: FileList, createdItem?: MarketplaceItem) {
    const targetItem = createdItem ?? items.find((item) => item.id === itemId)
    if (!canEditItem(targetItem)) {
      setStatus('This shared item is not available in this session.')
      return
    }

    try {
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
        imported.push({ ...createPartFromGCode(file.name, gcode, dxfByStem.get(stem(file.name)), itemId), ownerId: userId })
      }

      if (accountRef.current !== userId) return
      setParts((current) => {
        const item = targetItem
        const itemSku = item?.sku ?? 'ITEM'
        const existingCount = new Set([...catalogueComponents, ...current].filter(part => part.itemId === itemId).map(part => part.id)).size
        const nextImported = imported.map((part, index) => normalizePart(part, itemSku, existingCount + index))
        return [...current, ...nextImported]
      })
      setItems((current) => current.map((item) => (item.id === itemId ? { ...item, updatedAt: new Date().toISOString() } : item)))
      setStatus(imported.length > 0 ? `Imported ${imported.length} component file(s).` : 'No supported G-code files found.')
    } catch (error) { if (accountRef.current === userId) setStatus(errorMessage(error)) }
  }

  function saveGeneratedComponent(value: CamSave) {
    const selected = items.find(item => item.id === value.itemId)
    const target = items.find(item => itemFamily(item) === (selected ? itemFamily(selected) : value.itemId) && defaultItem(item))
    if (!canEditItem(target) || accountRef.current !== userId) throw new Error('The selected item is not available in this session.')
    const reserved = new Set([...catalogueComponents.filter(p => p.itemId === target!.id).map(p => p.id), ...componentSaves.jobs.filter(job => job.part?.itemId === value.itemId && job.status !== 'saved').map(job => job.id)]).size
    const part = normalizePart({ ...createPartFromGCode(value.filename, value.gcode, value.source, value.itemId), id: value.id, ownerId: userId }, target!.sku, reserved)
    part.name = part.name.replace(/-(?:6|12|15|18)mm(?:-2pass)?$/, '')
    part.metadata.materialVariants = materialVariantsSchema.parse(value.materialVariants)
    componentSaves.enqueue(part, target!.name)
  }

  async function persistGeneratedComponent(part: Part) {
    const selected = items.find(item => item.id === part.itemId)
    const target = items.find(item => itemFamily(item) === (selected ? itemFamily(selected) : part.itemId) && defaultItem(item))
    if (!canEditItem(target) || part.ownerId !== userId || accountRef.current !== userId) throw new Error('The selected item is not available in this session.')
    const result = await saveRemoteComponent(part, userId!)
    if (!result.ok) throw new Error(result.error ?? 'Component could not be saved. Try again.')
    if (accountRef.current !== userId) return
    persistedComponentIds.current.add(result.part?.id ?? part.id)
    setStatus(`Generated component added to ${target!.name}.`)
  }

  function importFiles(fileList: FileList) {
    if (!selectedItemId) {
      const item = newItem('Imported Item', userEmail, userId)
      setItems((current) => [...current, item])
      setSelectedItemId(item.id)
      void importFilesForItem(item.id, fileList, item)
      return
    }

    void importFilesForItem(selectedItemId, fileList)
  }

  function createMarketplaceItem() {
    const item = newItem(`Item ${items.length + 1}`, userEmail, userId)
    setItems((current) => [...current, item])
    setSelectedItemId(item.id)
    loadedItems.current.add(item.id)
    setPage('marketplace')
    setStatus('Created new marketplace item.')
    return item.id
  }

  function updateMarketplaceItem(itemId: string, patch: Partial<MarketplaceItem>) {
    const targetItem = items.find((item) => item.id === itemId)
    if (!canEditItem(targetItem)) {
      setStatus('This shared item is not available in this session.')
      return
    }

    setItems((current) => current.map((item) => (item.id === itemId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item)))
  }

  async function updateItemImage(itemId: string, image: ItemImage | null) {
    const item = items.find(value => value.id === itemId)
    if (!item || !canEditItem(item) || !userId || accountRef.current !== userId) throw new Error('This shared item is not available in this session.')
    await saveRemoteItemImage(item, image, userId)
    if (accountRef.current !== userId) return
  }

  async function deleteComponent(partId: string) {
    const part = parts.find((candidate) => candidate.id === partId)
    const item = part?.itemId ? items.find((candidate) => candidate.id === part.itemId) : undefined
    if (!canEditItem(item)) {
      setStatus('This shared item is not available in this session.')
      return
    }

    const isPlaced = sheet.instances.some((instance) => instance.partId === partId)
    if (isPlaced && !item?.version) {
      setStatus('Remove this component from the sheet before deleting it from the item.')
      return
    }

    try {
      await deleteRemoteComponent(partId, userId, item!.id)
      if (accountRef.current !== userId) return
      if (selectedPartId === partId) setSelectedPartId(undefined)
      setStatus('Removed component from item.')
    } catch (error) { if (accountRef.current === userId) setStatus(`Component was not removed: ${errorMessage(error)}`) }
  }

  async function saveCutSide(partId: string, cutSide: CutSide) {
    const part = parts.find(candidate => candidate.id === partId)
    const item = items.find(candidate => candidate.id === part?.itemId)
    if (!part || !canEditItem(item) || !userId) throw new Error('This shared component is not available in this session.')
    if (!persistedComponentIds.current.has(partId)) throw new Error('Wait for this component to finish uploading, then set its cutting side.')
    await saveRemoteCutSide(part, cutSide, userId)
    if (accountRef.current === userId) setStatus('Cutting side saved. New additions use the revised item; existing sheets keep their original version.')
  }

  function addPart(partId: string, x = sheet.borderSpacing, y = sheet.borderSpacing) {
    const parent = items.find(item => item.id === parts.find(part => part.id === partId)?.itemId)
    if (parent?.version?.status === 'draft') { setStatus('This item version is incomplete. Reload the catalogue before adding it.'); return }
    const part = parts.find(candidate => candidate.id === partId)
    const currentIsClosed = planningSheet.unavailableSheetIndices.includes(currentSheetIndex)
    const side = sheetCutSide(catalogueComponents, sheet, currentSheetIndex)
    if (part && (currentIsClosed || side === 'mixed' || !compatibleCutSides(side, part.cutSide))) {
      const target = Array.from({ length: sheetCount + 1 }, (_, index) => index).find(index => {
        const face = sheetCutSide(catalogueComponents, sheet, index)
        return !planningSheet.unavailableSheetIndices.includes(index) && face !== 'mixed' && compatibleCutSides(face, part.cutSide)
      })!
      setSheet(current => numberSheetParts({ ...current, instances: [...current.instances, newInstance(partId, x, y, target)] }))
      setActiveSheetIndex(target)
      setStatus(`Added ${part.name} to Sheet ${target + 1}: ${cutSideLabel(part.cutSide)}.`)
      return
    }
    setSheet((current) => numberSheetParts({
      ...current,
      instances: [...current.instances, newInstance(partId, x, y, currentSheetIndex)],
    }))
  }

  async function addAllItemComponents(itemId: string): Promise<number> {
    const item = items.find(value => value.id === itemId)
    if (!item || !userId || accountRef.current !== userId) throw new Error('This shared item is not available in this session.')
    if (item.version?.status === 'draft') throw new Error('This item version is incomplete. Reload the catalogue before adding it.')
    if (!loadedItems.current.has(itemId)) throw new Error('Wait for all item components to load before adding them.')
    const initial = orderSheetInputs.current, epoch = componentEpoch.current
    const obstacles = new Set(initial.sheet.instances.flatMap(instance => {
      const part = catalogueComponents.find(part => part.id === instance.partId)
      return part?.itemId ? [part.itemId] : []
    }))
    for (const id of obstacles) await ensureItemComponents(id)
    const latest = orderSheetInputs.current
    if (componentEpoch.current !== epoch || accountRef.current !== userId || initial.sheet !== latest.sheet || initial.items !== latest.items) throw new Error('Your sheet or catalogue changed. Try again.')
    if (latest.sheet.instances.some(instance => !latest.parts.some(part => part.id === instance.partId))) throw new Error('The sheet contains unavailable components. Refresh before adding this item.')
    const next = addItemToSheet(item, latest.parts, { ...latest.sheet, unavailableSheetIndices: planningSheet.unavailableSheetIndices }, userId, currentSheetIndex)
    const count = next.instances.length - latest.sheet.instances.length
    setSheet(next)
    setStatus(`Added all ${count} components of ${item.name} to the sheet.`)
    return count
  }

  async function addOrderToSheet(request: AddOrderRequest, signal: AbortSignal, onProgress: (progress: NestProgress) => void) {
    if (!userId || accountRef.current !== userId || loadedAccountId !== userId) throw new Error('Wait for your account catalogue to finish loading.')
    const importKey = `${request.shop}/${request.order.id}`
    if (workspaceRef.current.jobs.some(job => job.sheet.orderImports?.some(order => order.key === importKey && order.instanceIds.some(id => job.sheet.instances.some(i => i.id === id))))) throw new Error(`${request.order.name} is already included in a cutting job.`)
    const initial = orderSheetInputs.current
    const epoch = componentEpoch.current
    const required = new Set([...Object.values(request.matches), ...initial.sheet.instances.flatMap(instance => {
      const part = catalogueComponents.find(part => part.id === instance.partId)
      return part?.itemId ? [part.itemId] : []
    })])
    for (const id of required) {
      if (signal.aborted || accountRef.current !== userId || componentEpoch.current !== epoch) throw new Error('Order loading cancelled.')
      await ensureItemComponents(id)
    }
    const snapshot = orderSheetInputs.current
    if (signal.aborted || accountRef.current !== userId || componentEpoch.current !== epoch || initial.sheet !== snapshot.sheet || initial.items !== snapshot.items) throw new Error('Your sheet or catalogue changed. Try again.')
    const prepared = prepareOrderSheet(request, snapshot.items, snapshot.parts, { ...snapshot.sheet, unavailableSheetIndices: planningSheet.unavailableSheetIndices }, userId, currentSheetIndex)
    const instances = await nestOrder(prepared.parts, prepared.sheet, signal, onProgress)
    const latest = orderSheetInputs.current
    if (signal.aborted || accountRef.current !== userId || latest.sheet !== snapshot.sheet || latest.parts !== snapshot.parts || latest.items !== snapshot.items) throw new Error('Your sheet or catalogue changed. No order components were added; try again.')
    setSheet(prepared.finish(instances))
    setSelectedInstanceId(undefined)
    setPreview(undefined)
    setPreviewSimulation(undefined)
    setPendingExport(undefined)
    setPage('sheet')
    setStatus(`Added ${prepared.count} components for order ${request.order.name}. Review the sheet before cutting.`)
  }

  async function loadJobParts(jobs: ProductionJob[]) {
    const owner = userId, epoch = componentEpoch.current
    if (!owner || loadedAccountId !== owner) throw new Error('Wait for your catalogue to load.')
    const current = orderSheetInputs.current
    const ids = new Set(jobs.flatMap(job => job.sheet.instances.map(i => i.partId)))
    const itemIds = new Set([...current.componentIndex, ...current.parts].filter(part => ids.has(part.id)).flatMap(part => part.itemId ? [part.itemId] : []))
    for (const id of itemIds) await ensureItemComponents(id)
    if (accountRef.current !== owner || componentEpoch.current !== epoch) throw new Error('Your account or catalogue changed. Try again.')
    const loaded = orderSheetInputs.current.parts
    if ([...ids].some(id => !loaded.some(part => part.id === id))) throw new Error('Some original components are unavailable. Restore them before changing the plan.')
    return loaded.filter(part => ids.has(part.id))
  }

  async function downloadWorkspaceRecovery() {
    if (!recoverableWorkspace || !userId) return
    try {
      const jobs = recoverableWorkspace.jobs.map(job => newProductionJob(waitingExportSheet(job))).filter(job => job.sheet.instances.length)
      if (!jobs.length) throw new Error('The recovery copy has no uncut parts.')
      const restoredParts = await loadJobParts(jobs)
      const itemIds = new Set(restoredParts.map(part => part.itemId))
      downloadText('cutting-jobs-recovery.json', JSON.stringify({ version: 1, items: items.filter(item => itemIds.has(item.id)), parts: restoredParts, sheet: jobs[0].sheet, workspace: { activeId: jobs[0].id, jobs }, sheetHistory: [], savedAt: new Date().toISOString() }, null, 2), 'application/json')
    } catch (error) { setStatus(errorMessage(error)) }
  }

  async function updateJobSheetStage(id: string, index: number, stage: SheetStage) {
    const before = workspaceRef.current, job = before.jobs.find(job => job.id === id)!
    const updated = changeSheetStage(job, index, stage)
    setWorkspace({ ...before, jobs: before.jobs.map(job => job.id === id ? updated : job) })
    if (!await saveCurrentProject()) { setWorkspace(before); throw new Error('Progress could not be saved to the cloud. Reload the saved plan before continuing.') }
    if (stage === 'cut') await completeSheetRecuts(userId!, job.sheet.instances.filter(i => i.sheetIndex === index).flatMap(i => i.recutId ? [i.recutId] : []))
    setStatus(`Sheet ${index + 1} marked ${stage}. It is excluded from future nesting.`)
  }

  async function openJobLabels(id: string, index: number) {
    const before = workspaceRef.current, job = before.jobs.find(job => job.id === id)!
    await loadJobParts([job])
    if (workspaceRef.current !== before) throw new Error('The plan changed while loading. Try again.')
    setWorkspace({ ...before, activeId: id }); setActiveSheetIndex(index); setLabelsOpen(true)
  }

  async function replanWaitingJobs() {
    const before = workspaceRef.current
    const loaded = await loadJobParts(before.jobs.map(job => ({ ...job, sheet: waitingExportSheet(job) })))
    if (workspaceRef.current !== before) throw new Error('The plan changed while loading. Try again.')
    const next = await replanWaiting(before, loaded)
    if (workspaceRef.current !== before) throw new Error('The plan changed while re-planning. No layouts were changed; try again.')
    setWorkspace(next); setPendingExport(undefined); setPreview(undefined)
    if (!await saveCurrentProject()) throw new Error('Re-planning succeeded locally but the cloud save failed. Keep this page open and retry saving.')
    setStatus('Waiting sheets re-planned and saved. Review the changed layouts and export fresh cutting files and labels.')
  }

  async function addRecutToSheet(entry: MachineRecut, signal: AbortSignal) {
    if (!userId || entry.owner_id !== userId || entry.status !== 'queued') throw new Error('This re-cut is no longer available.')
    const owner = userId, before = workspaceRef.current
    if (before.jobs.some(job => job.sheet.instances.some(i => i.recutId === entry.id))) throw new Error('This replacement is already in a cutting job.')
    const run = await loadMachineRun(owner, entry.source_run_id, signal)
    const source = run.snapshot.map.parts.find(part => part.sheetIndex === entry.sheet_index && part.number === entry.part_number)
    if (!source) throw new Error('The original exported part could not be found.')
    let partId = source.partId, itemId = source.itemId
    // Old exports can be recovered from the matching saved sheet, with exact NC verification.
    if (!partId) {
      for (const history of sheetHistory.filter(history => history.name === run.name)) {
        const instance = history.sheet.instances.find(i => i.sheetIndex === entry.sheet_index && `P${String(i.partNumber).padStart(3, '0')}` === entry.part_number)
        if (!instance) continue
        const recovered = await loadJobParts([{ ...activeJob, sheet: history.sheet }])
        const check = run.snapshot.mode === 'combined' ? [exportCombinedGCode(recovered, history.sheet, run.snapshot.programs)] : exportPhysicalSheetGCodes(recovered, history.sheet, run.snapshot.programs)
        if (check.length === run.snapshot.files.length && check.every((file, i) => file.gcode === run.snapshot.files[i].gcode)) { partId = instance.partId; itemId = recovered.find(p => p.id === partId)?.itemId; break }
      }
    }
    if (!partId || !itemId) throw new Error('This older export has no recoverable component reference. Select the original component from the library for this replacement.')
    await ensureItemComponents(itemId)
    await loadJobParts([activeJob])
    if (signal.aborted || accountRef.current !== owner || workspaceRef.current !== before) throw new Error('Your account or selected job changed. Try again.')
    const latest = orderSheetInputs.current, part = latest.parts.find(part => part.id === partId), item = latest.items.find(item => item.id === itemId)
    if (!part || !item) throw new Error('The original component revision is unavailable.')
    const profile = run.snapshot.materialProfile ?? materialProfiles.find(profile => profile.label === run.snapshot.thickness)?.id
    if (sheet.instances.length && (sheet.materialProfile !== profile || (sheet.material ?? '').trim().toLowerCase() !== run.snapshot.material.trim().toLowerCase())) throw new Error(`Select a job using ${run.snapshot.thickness} ${run.snapshot.material}, or create an empty job for this replacement.`)
    const target = sheet.instances.length ? planningSheet : { ...planningSheet, materialProfile: profile, material: run.snapshot.material }
    const next = addItemToSheet(item, latest.parts, target, owner, currentSheetIndex, [part.id])
    const added = next.instances.at(-1)!
    added.recutId = entry.id; added.orderName = entry.order_number
    setSheet(next); setSelectedInstanceId(added.id); setActiveSheetIndex(added.sheetIndex); setPage('sheet')
    setPendingExport(undefined); setPreview(undefined)
    setStatus(`Added replacement ${entry.part_number} to Sheet ${added.sheetIndex + 1}. Review and export the updated layout.`)
  }

  function updateInstance(instanceId: string, patch: Partial<PartInstance>) {
    setSheet((current) => ({
      ...current,
      instances: current.instances.map((instance) => (instance.id === instanceId ? { ...instance, ...patch } : instance)),
    }))
  }

  function duplicateSelected() {
    if (!selectedInstance || !selectedInstancePart) return
    const copy = findDuplicatePlacement(selectedInstancePart, selectedInstance, sheetParts, sheet)
    setSheet((current) => numberSheetParts({ ...current, instances: [...current.instances, copy] }))
    setSelectedInstanceId(copy.id)
    setStatus('Duplicated part at the nearest open position.')
  }

  function deleteSelected() {
    if (!selectedInstanceId) return
    setSheet((current) => ({ ...current, instances: current.instances.filter((instance) => instance.id !== selectedInstanceId) }))
    setSelectedInstanceId(undefined)
  }

  function clearSheet(sheetIndex?: number) {
    const instances = sheet.instances.filter(instance => planningSheet.unavailableSheetIndices.includes(instance.sheetIndex) || (sheetIndex !== undefined && instance.sheetIndex !== sheetIndex))
    const count = sheet.instances.length - instances.length
    if (!count) return
    const target = sheetIndex === undefined ? planningSheet.unavailableSheetIndices.length ? 'waiting sheets' : 'all sheets' : `Sheet ${sheetIndex + 1}`
    if (!window.confirm(`Delete all ${count} part${count === 1 ? '' : 's'} from ${target}? This includes locked parts. Components will remain in the library. This cannot be undone.`)) return

    const remainingIds = new Set(instances.map(instance => instance.id))
    const nextSheet = {
      ...sheet,
      instances,
      orderImports: sheet.orderImports?.map(entry => ({ ...entry, instanceIds: entry.instanceIds.filter(id => remainingIds.has(id)) })).filter(entry => entry.instanceIds.length > 0),
    }
    setSheet(nextSheet)
    setSelectedInstanceId(undefined)
    setActiveSheetIndex(Math.min(currentSheetIndex, sheetCountFor(nextSheet) - 1))
    setPreview(undefined)
    setPreviewSimulation(undefined)
    setPendingExport(undefined)
    setStatus(`Deleted ${count} part${count === 1 ? '' : 's'} from ${target}.`)
  }

  function buildProject(): Project {
    return { version: 1, items, parts, componentIndex: catalogueComponents, sheet: programSheet, workspace, sheetHistory, savedAt: new Date().toISOString() }
  }

  async function exportProject() {
    if (exportingProject) return
    const epoch = componentEpoch.current
    const initial = orderSheetInputs.current
    setExportingProject(true)
    try {
      for (const item of items) {
        if (componentEpoch.current !== epoch || accountRef.current !== userId) throw new Error('Your account or catalogue changed. Export cancelled.')
        await ensureItemComponents(item.id)
      }
      if (componentEpoch.current !== epoch || accountRef.current !== userId) throw new Error('Your account or catalogue changed. Export cancelled.')
      const latest = orderSheetInputs.current
      if (latest.items !== initial.items || latest.sheet !== initial.sheet) throw new Error('Your sheet or items changed while loading. Export again to include those changes.')
      downloadText('sheet-builder-project.json', JSON.stringify({ ...buildProject(), parts: latest.parts, componentIndex: undefined }, null, 2), 'application/json')
      setStatus('Exported complete project.')
    } catch (error) { if (componentEpoch.current === epoch) setStatus(`Project export failed: ${errorMessage(error)}`) }
    finally { if (componentEpoch.current === epoch) setExportingProject(false) }
  }

  function buildHistoryEntry(): SheetHistoryEntry {
    const now = new Date()
    return {
      id: crypto.randomUUID(),
      name: sheet.name.trim() || `Sheet ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`,
      savedAt: now.toISOString(),
      sheet: normalizeSheet({ ...programSheet, instances: sheet.instances.map((instance) => ({ ...instance })) }),
      selectedItemId,
      itemCount: items.length,
      componentCount: catalogueComponents.length,
      placedCount: sheet.instances.length,
    }
  }

  async function saveCurrentProject(): Promise<boolean> {
    if (!userId || loadedAccountId !== userId) return false
    const currentWorkspace = workspaceRef.current
    const historyEntry = buildHistoryEntry()
    const nextHistory = [historyEntry, ...sheetHistory]
    const localSaved = saveProject({ version: 1, items, parts, componentIndex: catalogueComponents, sheet, workspace: currentWorkspace, sheetHistory: nextHistory, savedAt: new Date().toISOString() }, userId)
    if (!localSaved && !(remoteHydratedRef.current && canUseSupabase())) {
      setStatus('Could not save project; browser storage may be full.')
      return false
    }

    if (remoteHydratedRef.current && canUseSupabase()) {
      const newParts = parts.filter(part => !persistedComponentIds.current.has(part.id))
      const remoteSaved = await saveRemoteProject(items, newParts, sheet, selectedItemId, userId, currentWorkspace)
      const historySaved = remoteSaved.ok ? await saveRemoteSheetHistory(historyEntry, userId) : remoteSaved
      if (accountRef.current !== userId) return false
      if (!historySaved.ok) {
        setWorkspaceSaveError(historySaved.error ?? 'Cloud save failed')
        setStatus(`Cloud save failed: ${historySaved.error ?? 'unknown error'}`)
        return false
      }
      for (const part of newParts) persistedComponentIds.current.add(part.id)
      if (workspaceRef.current.updatedAt === currentWorkspace.updatedAt) { setSavedWorkspaceAt(currentWorkspace.updatedAt ?? ''); setWorkspaceSaveError('') }
      setSheetHistory(nextHistory)
      setStatus('Saved sheet to history.')
      return true
    }

    setSheetHistory(nextHistory)
    setStatus('Saved sheet to history.')
    return true
  }

  function loadSavedProject() {
    const loadedState = projectToAppState(loadProject(userId))
    if (!loadedState.restored) {
      setStatus('No saved project found in local browser storage.')
      return
    }

    setItems(loadedState.items)
    setComponentIndex(loadedState.parts)
    resetComponentLoading(loadedState.items, loadedState.items.map(item => item.id))
    setSelectedItemId(loadedState.selectedItemId)
    setParts(loadedState.parts)
    const savedWorkspace = loadProject(userId)?.workspace
    setWorkspace(savedWorkspace?.jobs.length ? savedWorkspace : newWorkspace(pruneMissingSheetInstances(normalizeSheet(loadedState.sheet), loadedState.parts)))
    setSheetHistory(loadedState.sheetHistory)
    setSelectedInstanceId(undefined)
    setActiveSheetIndex(0)
    setStatus('Loaded saved marketplace from this browser.')
  }

  async function importProject(fileList: FileList | null) {
    const file = fileList?.[0]
    if (!file || !userId) return
    let importedState: AppPersistenceState
    try {
      const project = JSON.parse(await readFile(file)) as Project
      if (accountRef.current !== userId) return
      const normalized = projectToAppState(project)
      importedState = projectToAppState(copyProjectToAccount({ ...project, ...normalized }, userId))
    } catch {
      setStatus('Could not import this project file.')
      return
    }
    setItems(current => [...current, ...importedState.items])
    setComponentIndex(current => [...current, ...importedState.parts])
    resetComponentLoading([...items, ...importedState.items], [...loadedItems.current, ...importedState.items.map(item => item.id)])
    setSelectedItemId(importedState.selectedItemId)
    setParts(current => [...current, ...importedState.parts])
    const importedJobs = importedState.workspace?.jobs.length ? importedState.workspace.jobs : [newProductionJob(pruneMissingSheetInstances(normalizeSheet(importedState.sheet), importedState.parts))]
    setWorkspace(current => ({ activeId: importedJobs[0].id, jobs: [...current.jobs, ...importedJobs] }))
    setSheetHistory(current => [...current, ...importedState.sheetHistory])
    setSelectedInstanceId(undefined)
    setActiveSheetIndex(0)
    setStatus(`Imported project ${file.name}.`)
  }

  function previewGCode() {
    if (!requirePrograms()) return
    try {
      const result = exportCombinedGCode(parts, waitingExportSheet(activeJob), programs)
      const simulation = safeSimulateGCode(result.gcode)
      setPreview(result.gcode)
      setPreviewSimulation(simulation)
      setStatus(
        result.errors.length > 0 || simulation.errors.length > 0
          ? `Preview generated with ${result.errors.length + simulation.errors.length} export/simulation error(s).`
          : `Preview generated. Estimated cutting time ${formatDuration(simulation.estimatedSeconds)}.`,
      )
    } catch (error) {
      setPreview(undefined)
      setPreviewSimulation(undefined)
      setStatus(`Preview failed: ${errorMessage(error)}`)
    }
  }

  function exportSummary(exportWarnings: string[], simulations: GCodeSimulation[], target: Sheet): ExportSummary {
    const targetParts = selectMaterialParts(parts, target).parts
    const estimatedCuttingTimeSeconds = simulations.reduce((total, simulation) => total + simulation.estimatedSeconds, 0)
    return {
      sheetName: target.name.trim() || defaultSheet.name,
      physicalSheets: sheetIndices(target).length,
      placedParts: target.instances.length,
      uniqueComponents: new Set(target.instances.map((instance) => instance.partId)).size,
      deepestCutMm: deepestSourceCut(targetParts, target),
      safeZ: effectiveSafeZ(target),
      estimatedCuttingTimeSeconds,
      simulatedDistanceMm: simulations.reduce((total, simulation) => total + simulation.totalDistanceMm, 0),
      simulationErrors: simulations.reduce((total, simulation) => total + simulation.errors.length, 0),
      simulationWarnings: simulations.reduce((total, simulation) => total + simulation.warnings.length, 0),
      reachCheckEnabled: target.instances.length > 0,
      screwMarkCount: sheetIndices(target).map(index => planScrewPositions(targetParts, target, index).points.length).reduce((total, count) => total + count, 0),
      spindleStartEnabled: target.gcodeSettings.spindleStartGcode.trim().length > 0,
      validationErrors: errors.length,
      validationWarnings: warnings.length,
      exportWarnings,
    }
  }

  function requirePublishedItems(): boolean {
    const placed = new Set(sheet.instances.map(instance => instance.partId))
    const parentIds = new Set(parts.filter(part => placed.has(part.id)).map(part => part.itemId))
    const draft = items.find(item => parentIds.has(item.id) && item.version?.status === 'draft')
    if (draft) { setStatus(`${draft.name} has an incomplete version. Reload the catalogue before exporting.`); return false }
    return true
  }

  async function prepareExport(mode: 'combined' | 'sheets') {
    if (!requirePrograms() || !requirePublishedItems() || !userId || exportBusyRef.current) return
    if (errors.length) { setStatus('Export blocked by validation errors.'); return }
    const job = activeJob, owner = userId, initialSheet = sheet
    if (!waitingSheetIndices(job).length) { setStatus('There are no waiting sheets to export.'); return }
    exportBusyRef.current = true; setExportBusy(true)
    try {
      const name = await reserveExportName(job.id, owner)
      if (accountRef.current !== owner || workspaceRef.current.activeId !== job.id || workspaceRef.current.jobs.find(value => value.id === job.id)?.sheet !== initialSheet) return
      const namedJob = { ...job, name, sheet: { ...job.sheet, name } }
      setWorkspace(current => ({ ...current, jobs: current.jobs.map(value => value.id === job.id ? namedJob : value) }))
      const revision = job.revision + 1
      const base = revision === 1 ? name : `${name}-r${revision}`
      const exportSheet = { ...waitingExportSheet(namedJob), name: base }
      const results = mode === 'combined' ? [{ ...exportCombinedGCode(parts, exportSheet, programs), sheetIndex: undefined }] : exportPhysicalSheetGCodes(parts, exportSheet, programs)
      const exportErrors = results.flatMap(result => result.errors)
      if (exportErrors.length) throw new Error(exportErrors[0])
      const files = results.map(result => ({
        filename: sheetGCodeFilename(result.sheetIndex === undefined ? base : `${base}-sheet-${result.sheetIndex + 1}`, parts, exportSheet, result.sheetIndex),
        sheetIndices: result.sheetIndex === undefined ? sheetIndices(exportSheet) : [result.sheetIndex],
        gcode: result.gcode, simulation: safeSimulateGCode(result.gcode),
      }))
      if (files.some(file => file.simulation.errors.length)) throw new Error('The generated program failed simulation.')
      setPendingExport({ id: crypto.randomUUID(), jobId: job.id, revision, mode, files,
        summary: { ...exportSummary(results.flatMap(result => result.warnings), files.map(file => file.simulation), exportSheet), sheetName: base, physicalSheets: sheetIndices(exportSheet).length, placedParts: exportSheet.instances.length },
        tabMap: { parts, sheet: { ...exportSheet, gcodeSettings: { ...exportSheet.gcodeSettings, ...programs } } },
      })
      setExportError('')
    } catch (error) { if (accountRef.current === owner) setStatus(`Export blocked: ${errorMessage(error)}`) }
    finally { exportBusyRef.current = false; setExportBusy(false) }
  }

  async function confirmPendingExport() {
    if (!pendingExport || !userId || exportBusyRef.current) return
    const exportToConfirm = pendingExport
    const ownerId = userId
    exportBusyRef.current = true
    setExportBusy(true); setExportError('')
    try {
      const snapshot = await buildExportSnapshot({ ...exportToConfirm, ...exportToConfirm.tabMap, items })
      if (accountRef.current !== ownerId) return
      await saveMachineRun(exportToConfirm.id, ownerId, snapshot)
      if (accountRef.current !== ownerId) return
      const beforeSavingPlan = workspaceRef.current
      setWorkspace(current => ({ ...current, jobs: current.jobs.map(job => job.id !== exportToConfirm.jobId ? job : {
        ...job, revision: exportToConfirm.revision,
        sheet: { ...job.sheet, instances: job.sheet.instances.map(instance => ({ ...instance, orderName: instance.orderName || job.sheet.orderImports?.find(order => order.instanceIds.includes(instance.id))?.name || job.sheet.orderNumber })) },
        sheets: { ...job.sheets, ...Object.fromEntries(exportToConfirm.files.flatMap(file => file.sheetIndices).map(index => [index, { stage: 'waiting' as const, combined: exportToConfirm.mode === 'combined', runId: exportToConfirm.id, signature: sheetSignature(job.sheet, index) }])) },
      }) }))
      const saved = await saveCurrentProject()
      if (!saved) { setWorkspace(beforeSavingPlan); throw new Error('The cutting plan could not be saved. Retry before downloading files') }
      if (accountRef.current !== ownerId) return
      exportToConfirm.files.forEach(file => downloadText(file.filename, file.gcode, 'application/x-gcode'))
      setPendingExport(undefined)
      if (accountRef.current === ownerId) setStatus(`Exported ${exportToConfirm.files.length} NC file(s) and saved to Cutting Jobs, waiting to cut.${saved ? '' : ' The editable sheet history could not be saved.'}`)
    } catch (error) {
      if (accountRef.current === ownerId) setExportError(`Export could not finish: ${errorMessage(error)}. Retry to save the same export; no new cutting programs will be generated.`)
    } finally { exportBusyRef.current = false; setExportBusy(false) }
  }

  function openHistoryEntry(entry: SheetHistoryEntry) {
    const nextSheet = pruneMissingSheetInstances(normalizeSheet(entry.sheet), catalogueComponents)
    const recalled = newProductionJob(nextSheet)
    setWorkspace(current => ({ activeId: recalled.id, jobs: [...current.jobs, recalled] }))
    setSelectedItemId(entry.selectedItemId)
    setSelectedInstanceId(undefined)
    setActiveSheetIndex(0)
    setPage('sheet')
    const removedCount = entry.sheet.instances.length - nextSheet.instances.length
    setStatus(removedCount > 0 ? `Opened ${entry.name}; removed ${removedCount} missing placed part(s).` : `Opened ${entry.name}.`)
  }

  function deleteHistoryEntry(entryId: string) {
    setSheetHistory((current) => current.filter((entry) => entry.id !== entryId))
    void deleteRemoteSheetHistory(entryId)
    setStatus('Deleted saved sheet from history.')
  }

  if (!authReady) {
    return <main className="login-shell"><div className="login-panel">Loading...</div></main>
  }

  if (!userEmail) {
    return <LoginPage onLogin={login} />
  }

  if (!mfaReady) {
    return (
      <MfaPage
        mode={mfaMode}
        enrollment={mfaEnrollment}
        error={mfaError}
        busy={mfaBusy}
        onStartEnrollment={startMfaEnrollment}
        onVerify={verifyMfaCode}
        onSignOut={() => void signOut()}
      />
    )
  }

  if (!userId || (loadedAccountId !== userId && page !== 'machine')) {
    return (
      <main className="login-shell">
        <div className="login-panel">
          <h2>{libraryLoadError ? 'Your items could not be loaded' : 'Loading shared items'}</h2>
          <p role={libraryLoadError ? 'alert' : 'status'}>{libraryLoadError ?? status}</p>
          {libraryLoadError && <button type="button" onClick={() => setLibraryReload(value => value + 1)}>Retry loading items</button>}
          <p>{userEmail}</p>
        </div>
      </main>
    )
  }

  return (
    <div className={`app${page === 'machine' ? ' machine-mode' : ''}`}>
      <header className="toolbar">
        <div className="brand-block">
          <h1>CNC Marketplace</h1>
          <span>{userEmail}</span>
        </div>
        <nav className="nav-tabs" aria-label="Primary">
          <button type="button" className={page === 'marketplace' ? 'active-nav' : ''} onClick={() => setPage('marketplace')}>Items</button>
          <button type="button" className={page === 'sheet' ? 'active-nav' : ''} onClick={() => setPage('sheet')}>Sheet</button>
          <button type="button" className={page === 'machine' ? 'active-nav' : ''} onClick={() => { window.location.hash = 'machine'; setPage('machine') }}>Cutting Jobs</button>
          <button type="button" className={page === 'history' ? 'active-nav' : ''} onClick={() => setPage('history')}>History</button>
          <button type="button" className={page === 'queue' ? 'active-nav' : ''} onClick={() => setPage('queue')}>Queue</button>
          <button type="button" className={page === 'orders' ? 'active-nav' : ''} onClick={() => setPage('orders')}>Orders</button>
          <button type="button" className={page === 'boxes' ? 'active-nav' : ''} onClick={() => setPage('boxes')}>Boxes</button>
          <button type="button" className={page === 'prints' ? 'active-nav' : ''} onClick={() => { window.location.hash = 'prints'; setPage('prints') }}>3D Prints</button>
          <button type="button" className={page === 'generate' ? 'active-nav' : ''} onClick={() => setPage('generate')}>Generate</button>
          <button type="button" className={page === 'profile' ? 'active-nav icon-text-button' : 'icon-text-button'} onClick={() => setPage('profile')}><UserRound size={16} />Profile</button>
        </nav>
        {loadedAccountId === userId && (page === 'sheet' || page === 'history') && <div className="production-tabs" role="tablist" aria-label="Open cutting jobs">
          {workspace.jobs.filter(job => !job.archived && (!job.sheet.instances.length || waitingSheetIndices(job).length)).map((job, index) => <button type="button" role="tab" aria-selected={job.id === activeJob.id} key={job.id} disabled={exportBusy} onClick={() => openJob(job.id)}>{job.name} · {materialProfiles.find(p => p.id === job.sheet.materialProfile)?.thickness ?? 'Original'} mm · {index + 1}</button>)}
          <button type="button" disabled={exportBusy} onClick={addJob}>New job</button>
          <button type="button" disabled={exportBusy || activeJob.archived || Object.values(activeJob.sheets).some(sheet => sheet.stage === 'cutting')} title="Remove this job and its waiting parts; keep previous exports and cut-sheet records. Mark any cutting sheets cut first." onClick={() => removeJob(activeJob.id)}>Remove job</button>
        </div>}
        {sheetReady && (page === 'sheet' || page === 'history') && <><div className="sheet-controls">
          <label className="sheet-name-control">
            Job
            <output>{activeJob.name}</output>
          </label>
          <label className="sheet-name-control">
            Order number
            <input value={sheet.orderNumber ?? ''} onChange={(event) => setSheet({ ...sheet, orderNumber: event.target.value })} />
          </label>
          <label className="sheet-name-control">
            Material
            <input value={sheet.material ?? ''} onChange={(event) => setSheet({ ...sheet, material: event.target.value })} />
          </label>
          <label>
            Thickness
            <select aria-label="Sheet material thickness" value={sheet.materialProfile ?? ''} onChange={event => {
              setSheet({ ...sheet, materialProfile: event.target.value ? event.target.value as MaterialProfileId : undefined })
              setPreview(undefined); setPreviewSimulation(undefined); setPendingExport(undefined)
              setStatus('Sheet material changed. Review the updated machining before export.')
            }}>
              <option value="">Original NC</option>
              {materialProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
            </select>
          </label>
          <label>
            W
            <input type="number" value={sheet.width} onChange={(event) => setSheet({ ...sheet, width: Number(event.target.value) })} />
          </label>
          <span>x</span>
          <label>
            H
            <input type="number" value={sheet.height} onChange={(event) => setSheet({ ...sheet, height: Number(event.target.value) })} />
          </label>
          <label>
            Gap
            <input type="number" value={sheet.spacing} onChange={(event) => setSheet({ ...sheet, spacing: Number(event.target.value) })} />
          </label>
          <label>
            Border
            <input type="number" value={sheet.borderSpacing} onChange={(event) => setSheet({ ...sheet, borderSpacing: Number(event.target.value) })} />
          </label>
          <label className="screw-mark-control" title="6 mm cutter; recessed screw heads">
            <input type="checkbox" checked={sheet.screwMarkingEnabled === true} onChange={(event) => setSheet({ ...sheet, screwMarkingEnabled: event.target.checked })} />
            Screw marks
          </label>
          <label className="screw-mark-control" title="Override above-surface rapid clearance; Z0 is the material surface">
            <input type="checkbox" checked={sheet.safeZOverrideMm != null} onChange={(event) => setSheet({ ...sheet, safeZOverrideMm: event.target.checked ? defaultSafeZOverrideMm : null })} />
            Override safe Z
          </label>
          <label>
            Safe Z (mm)
            <input type="number" min="0.1" step="0.1" disabled={sheet.safeZOverrideMm == null} value={sheet.safeZOverrideMm ?? defaultSafeZOverrideMm} onChange={(event) => setSheet({ ...sheet, safeZOverrideMm: Number(event.target.value) })} />
          </label>
        </div>
        <div className="toolbar-actions">
          {sheetLoadError && <button type="button" onClick={() => setComponentRetry(value => value + 1)}>Retry item components</button>}
          <AutoNestButton parts={parts} sheet={sheet} accountId={userId} onStatus={setStatus}
            onComplete={instances => {
              setSheet({ ...sheet, instances })
              setActiveSheetIndex(0)
            }}
          />
          <button type="button" className="danger" disabled={!waitingSheetIndices(activeJob).length} onClick={() => clearSheet()}>{planningSheet.unavailableSheetIndices.length ? 'Clear waiting sheets' : 'Clear All Sheets'}</button>
          <button type="button" onClick={() => void saveCurrentProject()}>Save Sheet</button>
          <button type="button" onClick={loadSavedProject}>Load Sheet</button>
          <button type="button" onClick={previewGCode}>Preview</button>
          <button type="button" className="icon-text-button" disabled={!sheet.instances.length} onClick={() => setLabelsOpen(true)}><Download size={16} /> Download Labels</button>
          <button type="button" disabled={exportBusy} onClick={() => void prepareExport('sheets')}>Export Sheets</button>
          <button type="button" className="primary" disabled={exportBusy} onClick={() => void prepareExport('combined')}>Export Combined</button>
          <button type="button" onClick={() => void signOut()}>Sign Out</button>
        </div></>}
        {(page === 'machine' || page === 'queue' || page === 'generate' || page === 'marketplace' || page === 'profile' || page === 'orders' || page === 'boxes' || page === 'prints') && <button type="button" onClick={() => void signOut()}>Sign Out</button>}
      </header>
      {loadedAccountId === userId && <div className="workspace-save-status" role="status">{workspaceSaveError ? <>Cloud save failed: {workspaceSaveError} <button type="button" onClick={() => void saveCurrentProject()}>Retry save</button><button type="button" onClick={() => setLibraryReload(value => value + 1)}>Reload saved plan</button></> : savedWorkspaceAt === workspace.updatedAt ? 'All job tabs saved' : 'Saving job tabs…'}{recoverableWorkspace && <button type="button" onClick={() => void downloadWorkspaceRecovery()}>Download unsaved recovery</button>}</div>}
      <ComponentSaveQueue jobs={componentSaves.jobs} onRetry={componentSaves.retry} onClear={componentSaves.clearSaved} />

      {page === 'prints' ? <Suspense fallback={<main>Loading 3D prints...</main>}><PrintablesPage key={userId} userId={userId} items={catalogueItems(items)} /></Suspense> : page === 'machine' ? navigationHash.startsWith('#machine/') ? <MachinePage key={userId} userId={userId} jobs={workspace.jobs} onCurrentLabels={openJobLabels} syncBlocked={Boolean(workspaceSaveError) || loadedAccountId !== userId} /> : <CuttingJobsPage jobs={workspace.jobs} components={catalogueComponents} onOpen={openJob} onNew={addJob} onRemove={removeJob} onStage={updateJobSheetStage} onLabels={openJobLabels} onReplan={replanWaitingJobs} /> : page === 'boxes' ? <BoxStockPage key={userId} userId={userId!} items={catalogueItems(items)} parts={catalogueComponents} /> : page === 'orders' ? <OrdersPage key={userId} userId={userId!} sheetTarget={{ items: items.filter(defaultItem), parts: catalogueComponents, sheetName: sheet.name, onAdd: addOrderToSheet }} /> : page === 'profile' ? <ProfilePage key={`${userId}:${programState.loading}:${programReload}`} email={userEmail} programs={programs} loading={programState.loading || programState.ownerId !== userId} error={programState.error} onRetry={reloadAccountPrograms} onSave={saveAccountPrograms} /> : page === 'generate' ? programs ? <Suspense fallback={<main>Loading generator...</main>}><CamPage key={userId} items={items.filter(editableItem)} onSave={saveGeneratedComponent} saveJobs={componentSaves.jobs} programs={programs} /></Suspense> : <main className="profile-page"><div className="profile-heading"><h2>{programState.loading ? 'Loading program settings...' : 'CNC program setup required'}</h2><button type="button" onClick={() => setPage('profile')}>User Profile</button></div></main> : page === 'queue' ? <QueuePage key={userId} userId={userId!} onAddRecut={addRecutToSheet} addedRecuts={workspace.jobs.flatMap(job => job.sheet.instances.flatMap(i => i.recutId ? [i.recutId] : []))} sheetName={`${activeJob.name} · ${materialProfiles.find(p => p.id === sheet.materialProfile)?.label ?? "Original NC"}`} /> : page === 'marketplace' ? (
        <MarketplacePage
          key={userId}
          items={items}
          parts={parts}
          componentIndex={catalogueComponents}
          componentLoads={componentLoads}
          onLoadComponents={ensureItemComponents}
          currentUserId={userId}
          onCreateItem={createMarketplaceItem}
          onSelectItem={setSelectedItemId}
          onUpdateItem={updateMarketplaceItem}
          onSaveImage={updateItemImage}
          onImportComponents={(itemId, files) => void importFilesForItem(itemId, files)}
          onDeleteComponent={deleteComponent}
          onAddToSheet={addPart}
          onSaveCutSide={saveCutSide}
          onAddItemToSheet={addAllItemComponents}
          onOpenSheet={() => setPage('sheet')}
        />
      ) : page === 'history' ? (
        <HistoryPage history={sheetHistory} onOpen={openHistoryEntry} onDelete={deleteHistoryEntry} />
      ) : !sheetReady ? <main className="items-page"><p role={sheetLoadError ? 'alert' : 'status'}>{sheetLoadError ?? 'Loading sheet components...'}</p>{sheetLoadError && <button type="button" onClick={() => setComponentRetry(value => value + 1)}>Retry sheet components</button>}</main> : (
        <div className="workspace">
          {planningSheet.unavailableSheetIndices.includes(currentSheetIndex) && <p role="status">Sheet {currentSheetIndex + 1} is {activeJob.sheets[currentSheetIndex].stage}. Its layout is fixed; new parts will go on waiting sheets.</p>}
          <PartLibrary
            items={items.filter(item => defaultItem(item) || item.id === selectedItemId)}
            parts={visibleParts}
            title={selectedItem ? selectedItem.name : 'Components'}
            emptyText={componentLoads[selectedItemId ?? '']?.error ?? (componentLoads[selectedItemId ?? '']?.state === 'loading' ? 'Loading components...' : 'Select an item above or upload components to add them to the sheet.')}
            selectedItemId={selectedItemId}
            selectedPartId={selectedPartId}
            onSelectItem={setSelectedItemId}
            onManageItems={() => setPage('marketplace')}
            canImport={canEditItem(selectedItem) && loadedItems.current.has(selectedItemId ?? '')}
            onImport={importFiles}
            onAdd={addPart}
            onSelect={setSelectedPartId}
          />
          <main className="sheet-stage">
            <div className="sheet-tabs" aria-label="Physical sheets">
              {Array.from({ length: sheetCount }, (_, index) => (
                <button
                  type="button"
                  key={index}
                  className={currentSheetIndex === index ? 'active-sheet-tab' : ''}
                  onClick={() => {
                    setActiveSheetIndex(index)
                    setSelectedInstanceId(undefined)
                  }}
                >
                  Sheet {index + 1}
                </button>
              ))}
              <button
                type="button"
                className="danger icon-text-button sheet-clear-button"
                aria-label={`Delete all parts from Sheet ${currentSheetIndex + 1}`}
                disabled={planningSheet.unavailableSheetIndices.includes(currentSheetIndex) || !sheet.instances.some(instance => instance.sheetIndex === currentSheetIndex)}
                onClick={() => clearSheet(currentSheetIndex)}
              >
                <Trash2 size={16} /> Delete All Parts
              </button>
            </div>
            <p className="sheet-cut-side" role="status">Sheet {currentSheetIndex + 1} · <strong>{cutSideLabel(sheetCutSide(sheetParts, sheet, currentSheetIndex))}</strong></p>
            <SheetEditor
              parts={sheetParts}
              sheet={sheet}
              sheetIndex={currentSheetIndex}
              selectedId={selectedInstance?.sheetIndex === currentSheetIndex ? selectedInstanceId : undefined}
              onAddPart={addPart}
              onSelect={setSelectedInstanceId}
              onUpdateInstance={updateInstance}
            />
          </main>
          <div className="side-stack">
            <PropertiesPanel
              part={planningSheet.unavailableSheetIndices.includes(currentSheetIndex) ? undefined : selectedInstancePart}
              instance={planningSheet.unavailableSheetIndices.includes(currentSheetIndex) ? undefined : selectedInstance}
              onUpdate={(patch) => selectedInstanceId && updateInstance(selectedInstanceId, patch)}
              onDuplicate={duplicateSelected}
              onDelete={deleteSelected}
            />
          </div>
        </div>
      )}

      {labelsOpen && <PartLabelsDialog key={userId} parts={parts} items={items} sheet={sheet} sheetIndex={currentSheetIndex} onClose={() => setLabelsOpen(false)} />}

      {pendingExport && (
        <div className="modal-backdrop" role="presentation">
          <section className="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-review-title">
            <div className="modal-header">
              <div>
                <h2 id="export-review-title">Review G-code Export</h2>
                <p>
                  {pendingExport.mode === 'combined'
                    ? 'Export Combined creates one G-code file for the full job.'
                    : 'Export Sheets creates one G-code file for each physical sheet.'}
                </p>
              </div>
              <button type="button" disabled={exportBusy} onClick={() => setPendingExport(undefined)}>Close</button>
            </div>

            <div className="export-summary-grid">
              <div>
                <span>Sheet</span>
                <strong>{pendingExport.summary.sheetName}</strong>
              </div>
              <div>
                <span>Files</span>
                <strong>{pendingExport.files.length}</strong>
              </div>
              <div>
                <span>Physical sheets</span>
                <strong>{pendingExport.summary.physicalSheets}</strong>
              </div>
              <div>
                <span>Placed parts</span>
                <strong>{pendingExport.summary.placedParts}</strong>
              </div>
              <div>
                <span>Components</span>
                <strong>{pendingExport.summary.uniqueComponents}</strong>
              </div>
              <div>
                <span>Deepest cut</span>
                <strong>{formatSetting(pendingExport.summary.deepestCutMm, ' mm')}</strong>
              </div>
              <div>
                <span>Safe Z</span>
                <strong>{formatSetting(pendingExport.summary.safeZ, ' mm')}</strong>
              </div>
              <div>
                <span>Estimated time</span>
                <strong>{formatDuration(pendingExport.summary.estimatedCuttingTimeSeconds)}</strong>
              </div>
              <div>
                <span>Sim distance</span>
                <strong>{formatDistance(pendingExport.summary.simulatedDistanceMm)}</strong>
              </div>
              <div>
                <span>Reach check</span>
                <strong>{pendingExport.summary.reachCheckEnabled ? 'Enabled' : 'Off'}</strong>
              </div>
              <div>
                <span>Screw marks</span>
                <strong>{pendingExport.summary.screwMarkCount > 0 ? `${pendingExport.summary.screwMarkCount} at 2 mm` : 'Off'}</strong>
              </div>
              {pendingExport.summary.screwMarkCount > 0 && (
                <div>
                  <span>After marking</span>
                  <strong>Spindle off / M00 pause</strong>
                </div>
              )}
              <div>
                <span>Spindle start block</span>
                <strong>{pendingExport.summary.spindleStartEnabled ? 'Configured' : 'Empty'}</strong>
              </div>
              <div>
                <span>Validation</span>
                <strong>
                  {pendingExport.summary.validationErrors + pendingExport.summary.simulationErrors} errors,{' '}
                  {pendingExport.summary.validationWarnings + pendingExport.summary.simulationWarnings} warnings
                </strong>
              </div>
            </div>

            {pendingExport.files[0] && (
              <GCodeSimulationPanel
                title={pendingExport.files.length === 1 ? 'Export Simulation' : `Export Simulation: ${pendingExport.files[0].filename}`}
                simulation={pendingExport.files[0].simulation}
              />
            )}

            <div className="export-file-list">
              <h3>Material face for each sheet</h3>
              <ul>{Array.from({ length: pendingExport.summary.physicalSheets }, (_, index) => <li key={index}>Sheet {index + 1}: {cutSideLabel(sheetCutSide(pendingExport.tabMap.parts, pendingExport.tabMap.sheet, index))}</li>)}</ul>
              <h3>Files to export</h3>
              <ul>
                {pendingExport.files.map((file) => (
                  <li key={file.filename}>{file.filename}</li>
                ))}
              </ul>
            </div>

            {pendingExport.summary.exportWarnings.length > 0 && (
              <div className="export-warnings">
                <h3>Export warnings</h3>
                <ul>
                  {[...new Set(pendingExport.summary.exportWarnings)].slice(0, 8).map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="modal-actions">
              <TabMapDownload parts={pendingExport.tabMap.parts} sheet={pendingExport.tabMap.sheet} />
              {exportError && <p role="alert">{exportError}</p>}
              <button type="button" disabled={exportBusy} onClick={() => setPendingExport(undefined)}>Cancel</button>
              <button type="button" className="primary" disabled={exportBusy} onClick={() => void confirmPendingExport()}>
                {exportBusy ? 'Saving export...' : 'Export G-code'}
              </button>
            </div>
          </section>
        </div>
      )}

      {page !== 'prints' && page !== 'machine' && page !== 'queue' && page !== 'generate' && page !== 'profile' && <section className="bottom-bar">
        <div>
          <strong>Status:</strong> {status}
        </div>
        {page !== 'marketplace' && <><div className={errors.length > 0 ? 'issue error' : 'issue'}>
          {errors.length} errors
        </div>
        <div className={warnings.length > 0 ? 'issue warning' : 'issue'}>
          {warnings.length} warnings
        </div></>}
        <button type="button" disabled={exportingProject} onClick={() => void exportProject()}>{exportingProject ? 'Loading project components...' : 'Export Project'}</button>
        <button type="button" onClick={() => importProjectRef.current?.click()}>Import Project</button>
        <input ref={importProjectRef} className="hidden-file" type="file" accept=".json" onChange={(event) => void importProject(event.target.files)} />
      </section>}

      {(page === 'sheet' || page === 'history') && (issues.length > 0 || preview || previewSimulation) && (
        <section className={`diagnostics ${previewSimulation ? 'with-simulator' : ''}`}>
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
                <button
                  type="button"
                  onClick={() => {
                    setPreview(undefined)
                    setPreviewSimulation(undefined)
                  }}
                >
                  Close
                </button>
              </div>
              <textarea readOnly value={preview} />
            </div>
          )}
          {previewSimulation && <GCodeSimulationPanel simulation={previewSimulation} />}
        </section>
      )}
    </div>
  )
}

export default App
