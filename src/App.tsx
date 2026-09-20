import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { Download, UserRound } from 'lucide-react'
import { ProfilePage } from './ui/ProfilePage'
import { loadProgramSettings, saveProgramSettings } from './storage/programSettingsStore'
import type { ProgramSettings } from './gcode/programSettings'
import { numberSheetParts } from './labels/partLabels'
import { PartLabelsDialog } from './ui/PartLabelsDialog'
import { TabMapDownload } from './ui/TabMapDownload'
import { QueuePage } from './ui/QueuePage'
import { OrdersPage } from './ui/OrdersPage'
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
import { itemImageSchema, type ItemImage } from './models/ItemImage'
import type { Part } from './models/Part'
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
  saveRemoteComponent,
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

const defaultSheet: Sheet = {
  name: 'Untitled Sheet',
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

function pruneMissingSheetInstances(sheet: Sheet, availableParts: Part[]): Sheet {
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

function filenameSafe(value: string): string {
  return (skuBase(value).toLowerCase() || 'combined-sheet').replace(/-+/g, '-')
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
  return {
    id: crypto.randomUUID(),
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
      sheet: pruneMissingSheetInstances(normalizeSheet(project.sheet), parts),
      sheetHistory: project.sheetHistory ?? [],
      selectedItemId: fallbackItemId,
      restored: true,
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
  const [page, setPage] = useState<'marketplace' | 'sheet' | 'history' | 'queue' | 'generate' | 'profile' | 'orders' | 'boxes'>('marketplace')
  const [items, setItems] = useState<MarketplaceItem[]>(initialState.items)
  const [parts, setParts] = useState<Part[]>(initialState.parts)
  const [sheet, setSheet] = useState<Sheet>(normalizeSheet(initialState.sheet))
  const [activeSheetIndex, setActiveSheetIndex] = useState(0)
  const [sheetHistory, setSheetHistory] = useState<SheetHistoryEntry[]>(initialState.sheetHistory)
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(initialState.selectedItemId)
  const [selectedPartId, setSelectedPartId] = useState<string>()
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>()
  const [preview, setPreview] = useState<string>()
  const [previewSimulation, setPreviewSimulation] = useState<GCodeSimulation>()
  const [pendingExport, setPendingExport] = useState<PendingExport>()
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
  const [loadedAccountId, setLoadedAccountId] = useState<string>()
  const [programState, setProgramState] = useState<{ ownerId?: string; programs?: ProgramSettings; loading: boolean; error?: string }>({ loading: true })
  const [programReload, setProgramReload] = useState(0)
  const programs = programState.ownerId === userId && !programState.loading && !programState.error ? programState.programs : undefined
  const programSheet = programs ? { ...sheet, gcodeSettings: { ...sheet.gcodeSettings, ...programs } } : sheet
  const componentSaves = useComponentSaveQueue(userId, persistGeneratedComponent)

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
  const issues = useMemo(() => validateSheet(parts, sheet), [parts, sheet])
  const errors = issues.filter((issue) => issue.level === 'error')
  const warnings = issues.filter((issue) => issue.level === 'warning')

  function canEditItem(item?: MarketplaceItem): boolean {
    return Boolean(userId && item && item.ownerId === userId)
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

    const timeout = window.setTimeout(() => {
      if (accountRef.current !== userId) return
      saveProject({ version: 1, items, parts, sheet, sheetHistory, savedAt: new Date().toISOString() }, userId)
      if (remoteHydratedRef.current && canUseSupabase()) {
        void saveRemoteProject(items, parts, sheet, selectedItemId, userId).then((result) => {
          if (accountRef.current === userId && !result.ok) setStatus(`Cloud save failed: ${result.error ?? 'unknown error'}`)
        })
      }
    }, 300)

    return () => window.clearTimeout(timeout)
  }, [items, parts, selectedItemId, sheet, sheetHistory, userId, loadedAccountId, mfaReady])

  useEffect(() => {
    if (!canUseSupabase() || !userId || !mfaReady) return

    let cancelled = false
    remoteHydratedRef.current = false
    void loadRemoteProject(userId).catch(() => undefined).then((remoteProject) => {
      if (cancelled || accountRef.current !== userId) return
      remoteHydratedRef.current = Boolean(remoteProject)
      const project = remoteProject
        ? privateProject({ version: 1, ...remoteProject, sheet: remoteProject.sheet ?? defaultSheet, savedAt: new Date().toISOString() }, userId)
        : loadProject(userId)
      const loaded = projectToAppState(project)
      setItems(loaded.items)
      setParts(loaded.parts)
      setSheetHistory(loaded.sheetHistory)
      setSheet(pruneMissingSheetInstances({ ...loaded.sheet, gcodePresets: mergePresets(loaded.sheet.gcodePresets, remoteProject?.gcodePresets ?? []) }, loaded.parts))
      setSelectedItemId(loaded.items.some((item) => item.id === remoteProject?.selectedItemId) ? remoteProject?.selectedItemId : loaded.selectedItemId)
      setSelectedInstanceId(undefined)
      setActiveSheetIndex(0)
      setLoadedAccountId(userId)
      setStatus(remoteProject ? 'Loaded your private item library.' : 'Cloud unavailable. Using this account\'s browser backup; cloud saving is disabled.')
    })

    return () => {
      cancelled = true
    }
  }, [userId, mfaReady])

  useEffect(() => {
    if (!supabase) return

    const listener = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUserId = session?.user.id
      if (accountRef.current !== nextUserId || !session) {
        accountRef.current = nextUserId
        remoteHydratedRef.current = false
        setLoadedAccountId(undefined)
        setProgramState({ loading: true })
        setMfaReady(false)
        setMfaMode('enroll')
        setMfaFactors([])
        setMfaEnrollment(undefined)
        setMfaError(undefined)
        setItems([])
        setParts([])
        setSheetHistory([])
        setSheet(defaultSheet)
        setActiveSheetIndex(0)
        setSelectedItemId(undefined)
        setSelectedPartId(undefined)
        setSelectedInstanceId(undefined)
        setPreview(undefined)
        setPreviewSimulation(undefined)
        setPendingExport(undefined)
        setLabelsOpen(false)
        setPage('marketplace')
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
      const result = await saveRemoteProject(items, parts, sheet, selectedItemId, userId)
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
      setStatus('This item is not in your account.')
      return
    }

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
      const existingCount = current.filter((part) => part.itemId === itemId).length
      const nextImported = imported.map((part, index) => normalizePart(part, itemSku, existingCount + index))
      return [...current, ...nextImported]
    })
    setItems((current) => current.map((item) => (item.id === itemId ? { ...item, updatedAt: new Date().toISOString() } : item)))
    setStatus(imported.length > 0 ? `Imported ${imported.length} component file(s).` : 'No supported G-code files found.')
  }

  function saveGeneratedComponent(value: CamSave) {
    const target = items.find(item => item.id === value.itemId)
    if (!canEditItem(target) || accountRef.current !== userId) throw new Error('The selected item is not in your current account.')
    const reserved = new Set([...parts.filter(p => p.itemId === value.itemId).map(p => p.id), ...componentSaves.jobs.filter(job => job.part?.itemId === value.itemId).map(job => job.id)]).size
    const part = normalizePart({ ...createPartFromGCode(value.filename, value.gcode, value.source, value.itemId), id: value.id, ownerId: userId }, target!.sku, reserved)
    part.name = part.name.replace(/-(?:6|12|15|18)mm(?:-2pass)?$/, '')
    part.metadata.materialVariants = materialVariantsSchema.parse(value.materialVariants)
    componentSaves.enqueue(part, target!.name)
  }

  async function persistGeneratedComponent(part: Part) {
    const target = items.find(item => item.id === part.itemId)
    if (!canEditItem(target) || part.ownerId !== userId || accountRef.current !== userId) throw new Error('The selected item is not in your current account.')
    const result = await saveRemoteComponent(part, userId!)
    if (!result.ok) throw new Error(result.error ?? 'Component could not be saved. Try again.')
    if (accountRef.current !== userId) return
    setParts(current => [...current.filter(p => p.id !== part.id), part])
    setItems(current => current.map(item => item.id === part.itemId ? { ...item, updatedAt: new Date().toISOString() } : item))
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
    setPage('marketplace')
    setStatus('Created new marketplace item.')
    return item.id
  }

  function updateMarketplaceItem(itemId: string, patch: Partial<MarketplaceItem>) {
    const targetItem = items.find((item) => item.id === itemId)
    if (!canEditItem(targetItem)) {
      setStatus('This item is not in your account.')
      return
    }

    setItems((current) => current.map((item) => (item.id === itemId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item)))
  }

  async function updateItemImage(itemId: string, image: ItemImage | null) {
    const item = items.find(value => value.id === itemId)
    if (!item || !canEditItem(item) || !userId || accountRef.current !== userId) throw new Error('This item is not in your account.')
    await saveRemoteItemImage(item, image, userId)
    if (accountRef.current !== userId) return
    setItems(current => current.map(value => value.id === itemId ? { ...value, image, updatedAt: new Date().toISOString() } : value))
  }

  function deleteComponent(partId: string) {
    const part = parts.find((candidate) => candidate.id === partId)
    const item = part?.itemId ? items.find((candidate) => candidate.id === part.itemId) : undefined
    if (!canEditItem(item)) {
      setStatus('This item is not in your account.')
      return
    }

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

  function addPart(partId: string, x = sheet.borderSpacing, y = sheet.borderSpacing) {
    setSheet((current) => numberSheetParts({
      ...current,
      instances: [...current.instances, newInstance(partId, x, y, currentSheetIndex)],
    }))
  }

  function addAllItemComponents(itemId: string): number {
    const item = items.find(value => value.id === itemId)
    if (!item || !userId || accountRef.current !== userId) throw new Error('This item is not in your account.')
    const next = addItemToSheet(item, parts, sheet, userId, currentSheetIndex)
    const count = next.instances.length - sheet.instances.length
    setSheet(next)
    setStatus(`Added all ${count} components of ${item.name} to the sheet.`)
    return count
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

  function clearSheet() {
    setSheet((current) => ({ ...current, instances: [] }))
    setSelectedInstanceId(undefined)
    setActiveSheetIndex(0)
    setPreview(undefined)
    setStatus('Cleared placed parts from the sheet.')
  }

  function buildProject(): Project {
    return { version: 1, items, parts, sheet: programSheet, sheetHistory, savedAt: new Date().toISOString() }
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
      componentCount: parts.length,
      placedCount: sheet.instances.length,
    }
  }

  async function saveCurrentProject(): Promise<boolean> {
    if (!userId || loadedAccountId !== userId) return false
    const historyEntry = buildHistoryEntry()
    const nextHistory = [historyEntry, ...sheetHistory]
    const localSaved = saveProject({ version: 1, items, parts, sheet, sheetHistory: nextHistory, savedAt: new Date().toISOString() }, userId)
    if (!localSaved) {
      setStatus('Could not save project; browser storage may be full.')
      return false
    }

    if (remoteHydratedRef.current && canUseSupabase()) {
      const remoteSaved = await saveRemoteProject(items, parts, sheet, selectedItemId, userId)
      const historySaved = remoteSaved.ok ? await saveRemoteSheetHistory(historyEntry, userId) : remoteSaved
      if (accountRef.current !== userId) return false
      if (!historySaved.ok) {
        setStatus(`Cloud save failed: ${historySaved.error ?? 'unknown error'}`)
        return false
      }
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
    setSelectedItemId(loadedState.selectedItemId)
    setParts(loadedState.parts)
    setSheet(pruneMissingSheetInstances(normalizeSheet(loadedState.sheet), loadedState.parts))
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
    setItems(importedState.items)
    setSelectedItemId(importedState.selectedItemId)
    setParts(importedState.parts)
    setSheet(pruneMissingSheetInstances(normalizeSheet(importedState.sheet), importedState.parts))
    setSheetHistory(importedState.sheetHistory)
    setSelectedInstanceId(undefined)
    setActiveSheetIndex(0)
    setStatus(`Imported project ${file.name}.`)
  }

  function previewGCode() {
    if (!requirePrograms()) return
    try {
      const result = exportCombinedGCode(parts, sheet, programs)
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

  function exportSummary(exportWarnings: string[], simulations: GCodeSimulation[]): ExportSummary {
    const estimatedCuttingTimeSeconds = simulations.reduce((total, simulation) => total + simulation.estimatedSeconds, 0)
    return {
      sheetName: sheet.name.trim() || defaultSheet.name,
      physicalSheets: sheetCount,
      placedParts: sheet.instances.length,
      uniqueComponents: new Set(sheet.instances.map((instance) => instance.partId)).size,
      deepestCutMm: deepestSourceCut(sheetParts, sheet),
      safeZ: effectiveSafeZ(sheet),
      estimatedCuttingTimeSeconds,
      simulatedDistanceMm: simulations.reduce((total, simulation) => total + simulation.totalDistanceMm, 0),
      simulationErrors: simulations.reduce((total, simulation) => total + simulation.errors.length, 0),
      simulationWarnings: simulations.reduce((total, simulation) => total + simulation.warnings.length, 0),
      reachCheckEnabled: sheet.instances.length > 0,
      screwMarkCount: Array.from({ length: sheetCount }, (_, index) => planScrewPositions(sheetParts, sheet, index).points.length).reduce((total, count) => total + count, 0),
      spindleStartEnabled: sheet.gcodeSettings.spindleStartGcode.trim().length > 0,
      validationErrors: errors.length,
      validationWarnings: warnings.length,
      exportWarnings,
    }
  }

  function prepareCombinedExport() {
    if (!requirePrograms()) return
    if (errors.length > 0) {
      setStatus('Export blocked by validation errors.')
      return
    }

    const result = exportCombinedGCode(parts, sheet, programs)
    if (result.errors.length > 0) {
      setStatus(`Export blocked: ${result.errors[0]}`)
      setPreview(result.gcode)
      return
    }

    const filename = `${filenameSafe(sheet.name)}.nc`
    const simulation = safeSimulateGCode(result.gcode)
    if (simulation.errors.length > 0) {
      setStatus(`Export blocked by ${simulation.errors.length} simulation error(s).`)
      setPreview(result.gcode)
      setPreviewSimulation(simulation)
      return
    }
    setPendingExport({
      mode: 'combined',
      files: [{ filename, gcode: result.gcode, simulation }],
      summary: exportSummary(result.warnings, [simulation]),
      tabMap: { parts, sheet },
    })
  }

  function prepareSheetExports() {
    if (!requirePrograms()) return
    if (errors.length > 0) {
      setStatus('Export blocked by validation errors.')
      return
    }

    const results = exportPhysicalSheetGCodes(parts, sheet, programs)
    const exportErrors = results.flatMap((result) => result.errors)
    if (exportErrors.length > 0) {
      setStatus(`Export blocked: ${exportErrors[0]}`)
      setPreview(results.map((result) => result.gcode).join('\n\n'))
      return
    }

    const base = filenameSafe(sheet.name)
    const files = results.map((result) => ({
      filename: `${base}-sheet-${result.sheetIndex + 1}.nc`,
      gcode: result.gcode,
      simulation: safeSimulateGCode(result.gcode),
    }))
    const simulationErrors = files.flatMap((file) => file.simulation.errors)
    if (simulationErrors.length > 0) {
      setStatus(`Export blocked by ${simulationErrors.length} simulation error(s).`)
      setPreview(files.map((file) => file.gcode).join('\n\n'))
      setPreviewSimulation(files[0]?.simulation)
      return
    }
    setPendingExport({
      mode: 'sheets',
      files,
      summary: exportSummary(results.flatMap((result) => result.warnings), files.map((file) => file.simulation)),
      tabMap: { parts, sheet },
    })
  }

  async function confirmPendingExport() {
    if (!pendingExport) return
    const exportToConfirm = pendingExport

    exportToConfirm.files.forEach((file) => {
      downloadText(file.filename, file.gcode, 'application/x-gcode')
    })
    setPendingExport(undefined)

    const saved = await saveCurrentProject()
    setStatus(
      saved
        ? exportToConfirm.mode === 'combined'
          ? `Saved sheet and exported ${exportToConfirm.files[0].filename}.`
          : `Saved sheet and exported ${exportToConfirm.files.length} sheet G-code file(s).`
        : exportToConfirm.mode === 'combined'
          ? `Exported ${exportToConfirm.files[0].filename}, but could not save the sheet.`
          : `Exported ${exportToConfirm.files.length} sheet G-code file(s), but could not save the sheet.`,
    )
  }

  function openHistoryEntry(entry: SheetHistoryEntry) {
    const nextSheet = pruneMissingSheetInstances(normalizeSheet(entry.sheet), parts)
    setSheet(nextSheet)
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

  if (!userId || loadedAccountId !== userId) {
    return <main className="login-shell"><div className="login-panel">Loading your account...</div></main>
  }

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand-block">
          <h1>CNC Marketplace</h1>
          <span>{userEmail}</span>
        </div>
        <nav className="nav-tabs" aria-label="Primary">
          <button type="button" className={page === 'marketplace' ? 'active-nav' : ''} onClick={() => setPage('marketplace')}>Items</button>
          <button type="button" className={page === 'sheet' ? 'active-nav' : ''} onClick={() => setPage('sheet')}>Sheet</button>
          <button type="button" className={page === 'history' ? 'active-nav' : ''} onClick={() => setPage('history')}>History</button>
          <button type="button" className={page === 'queue' ? 'active-nav' : ''} onClick={() => setPage('queue')}>Queue</button>
          <button type="button" className={page === 'orders' ? 'active-nav' : ''} onClick={() => setPage('orders')}>Orders</button>
          <button type="button" className={page === 'boxes' ? 'active-nav' : ''} onClick={() => setPage('boxes')}>Boxes</button>
          <button type="button" className={page === 'generate' ? 'active-nav' : ''} onClick={() => setPage('generate')}>Generate</button>
          <button type="button" className={page === 'profile' ? 'active-nav icon-text-button' : 'icon-text-button'} onClick={() => setPage('profile')}><UserRound size={16} />Profile</button>
        </nav>
        {(page === 'sheet' || page === 'history') && <><div className="sheet-controls">
          <label className="sheet-name-control">
            Job name
            <input value={sheet.name} onChange={(event) => setSheet({ ...sheet, name: event.target.value })} />
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
          <AutoNestButton parts={parts} sheet={sheet} accountId={userId} onStatus={setStatus}
            onComplete={instances => {
              setSheet({ ...sheet, instances })
              setActiveSheetIndex(0)
            }}
          />
          <button type="button" onClick={clearSheet}>Clear Sheet</button>
          <button type="button" onClick={() => void saveCurrentProject()}>Save Sheet</button>
          <button type="button" onClick={loadSavedProject}>Load Sheet</button>
          <button type="button" onClick={previewGCode}>Preview</button>
          <button type="button" className="icon-text-button" disabled={!sheet.instances.length} onClick={() => setLabelsOpen(true)}><Download size={16} /> Download Labels</button>
          <button type="button" onClick={prepareSheetExports}>Export Sheets</button>
          <button type="button" className="primary" onClick={prepareCombinedExport}>Export Combined</button>
          <button type="button" onClick={() => void signOut()}>Sign Out</button>
        </div></>}
        {(page === 'queue' || page === 'generate' || page === 'marketplace' || page === 'profile' || page === 'orders' || page === 'boxes') && <button type="button" onClick={() => void signOut()}>Sign Out</button>}
      </header>
      <ComponentSaveQueue jobs={componentSaves.jobs} onRetry={componentSaves.retry} onClear={componentSaves.clearSaved} />

      {page === 'boxes' ? <BoxStockPage key={userId} userId={userId!} items={items} parts={parts} /> : page === 'orders' ? <OrdersPage key={userId} userId={userId!} /> : page === 'profile' ? <ProfilePage key={`${userId}:${programState.loading}:${programReload}`} email={userEmail} programs={programs} loading={programState.loading || programState.ownerId !== userId} error={programState.error} onRetry={reloadAccountPrograms} onSave={saveAccountPrograms} /> : page === 'generate' ? programs ? <Suspense fallback={<main>Loading generator...</main>}><CamPage key={userId} items={items.filter(item => item.ownerId === userId)} onSave={saveGeneratedComponent} saveJobs={componentSaves.jobs} programs={programs} /></Suspense> : <main className="profile-page"><div className="profile-heading"><h2>{programState.loading ? 'Loading program settings...' : 'CNC program setup required'}</h2><button type="button" onClick={() => setPage('profile')}>User Profile</button></div></main> : page === 'queue' ? <QueuePage key={userId} userId={userId!} /> : page === 'marketplace' ? (
        <MarketplacePage
          key={userId}
          items={items}
          parts={parts}
          currentUserId={userId}
          onCreateItem={createMarketplaceItem}
          onSelectItem={setSelectedItemId}
          onUpdateItem={updateMarketplaceItem}
          onSaveImage={updateItemImage}
          onImportComponents={(itemId, files) => void importFilesForItem(itemId, files)}
          onDeleteComponent={deleteComponent}
          onAddToSheet={addPart}
          onAddItemToSheet={addAllItemComponents}
          onOpenSheet={() => setPage('sheet')}
        />
      ) : page === 'history' ? (
        <HistoryPage history={sheetHistory} onOpen={openHistoryEntry} onDelete={deleteHistoryEntry} />
      ) : (
        <div className="workspace">
          <PartLibrary
            items={items}
            parts={visibleParts}
            title={selectedItem ? selectedItem.name : 'Components'}
            emptyText="Select an item above or upload components to add them to the sheet."
            selectedItemId={selectedItemId}
            selectedPartId={selectedPartId}
            onSelectItem={setSelectedItemId}
            onManageItems={() => setPage('marketplace')}
            canImport={canEditItem(selectedItem)}
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
            </div>
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
              part={selectedInstancePart}
              instance={selectedInstance}
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
              <button type="button" onClick={() => setPendingExport(undefined)}>Close</button>
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
              <button type="button" onClick={() => setPendingExport(undefined)}>Cancel</button>
              <button type="button" className="primary" onClick={() => void confirmPendingExport()}>
                Export G-code
              </button>
            </div>
          </section>
        </div>
      )}

      {page !== 'queue' && page !== 'generate' && page !== 'profile' && <section className="bottom-bar">
        <div>
          <strong>Status:</strong> {status}
        </div>
        {page !== 'marketplace' && <><div className={errors.length > 0 ? 'issue error' : 'issue'}>
          {errors.length} errors
        </div>
        <div className={warnings.length > 0 ? 'issue warning' : 'issue'}>
          {warnings.length} warnings
        </div></>}
        <button type="button" onClick={() => downloadText('sheet-builder-project.json', JSON.stringify(buildProject(), null, 2), 'application/json')}>Export Project</button>
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
