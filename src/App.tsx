import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { exportCombinedGCode, exportPhysicalSheetGCodes } from './gcode/exporter'
import { createPartFromGCode } from './gcode/importPart'
import { instanceBounds } from './gcode/transform'
import { validateSheet } from './gcode/validator'
import type { MarketplaceItem } from './models/Item'
import type { Part } from './models/Part'
import type { PartInstance } from './models/PartInstance'
import type { Project, SheetHistoryEntry } from './models/Project'
import type { GCodePreset, Sheet } from './models/Sheet'
import { rectsOverlap } from './models/geometry'
import { autoNest } from './nesting/nestingEngine'
import { downloadText, loadProject, saveProject } from './storage/projectStorage'
import { supabase } from './storage/supabaseClient'
import {
  canUseSupabase,
  deleteRemoteGCodePreset,
  deleteRemoteComponent,
  deleteRemoteSheetHistory,
  loadRemoteProject,
  saveRemoteGCodePreset,
  saveRemoteProject,
  saveRemoteSheetHistory,
} from './storage/supabaseProjectStore'
import { GCodeSettings } from './ui/GCodeSettings'
import { HistoryPage } from './ui/HistoryPage'
import { LoginPage } from './ui/LoginPage'
import { MarketplacePage } from './ui/MarketplacePage'
import { MfaPage } from './ui/MfaPage'
import type { MfaEnrollment } from './ui/MfaPage'
import { PartLibrary } from './ui/PartLibrary'
import { PropertiesPanel } from './ui/PropertiesPanel'
import { SheetEditor } from './ui/SheetEditor'

const defaultSheet: Sheet = {
  name: 'Untitled Sheet',
  width: 1220,
  height: 1220,
  spacing: 5,
  borderSpacing: 10,
  instances: [],
  gcodeSettings: {
    startGcode: 'G21\nG17\nG90\nG94',
    spindleStartGcode: 'S18000\nM03',
    endGcode: 'M05\nM30',
    safeZ: 5,
    maxDepthOfCut: 6,
    cuttingFeedRateMmPerMinute: 4500,
    plungeFeedRateMmPerMinute: 600,
    rampFeedRateMmPerMinute: 600,
    xyFeedRateMmPerSecond: 50,
    applyXyFeedRate: false,
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
        maxDepthOfCut: 6,
        cuttingFeedRateMmPerMinute: 4500,
        plungeFeedRateMmPerMinute: 600,
        rampFeedRateMmPerMinute: 600,
        xyFeedRateMmPerSecond: 50,
        applyXyFeedRate: false,
      },
    },
  ],
  defaultGcodePresetId: 'default-estlcam-mm',
}

function normalizeSheet(sheet: Sheet): Sheet {
  const gcodeSettings = {
    ...defaultSheet.gcodeSettings,
    ...sheet.gcodeSettings,
  }
  if (gcodeSettings.xyFeedRateMmPerSecond === undefined && gcodeSettings.xyFeedRate !== undefined) {
    gcodeSettings.xyFeedRateMmPerSecond = gcodeSettings.xyFeedRate / 60
  }
  if (gcodeSettings.cuttingFeedRateMmPerMinute === undefined && gcodeSettings.xyFeedRateMmPerSecond !== undefined) {
    gcodeSettings.cuttingFeedRateMmPerMinute = gcodeSettings.xyFeedRateMmPerSecond * 60
  }
  if (gcodeSettings.plungeFeedRateMmPerMinute === undefined) {
    gcodeSettings.plungeFeedRateMmPerMinute = Math.min(gcodeSettings.cuttingFeedRateMmPerMinute ?? 600, 600)
  }
  if (gcodeSettings.rampFeedRateMmPerMinute === undefined) {
    gcodeSettings.rampFeedRateMmPerMinute = gcodeSettings.plungeFeedRateMmPerMinute
  }
  const presets = sheet.gcodePresets && sheet.gcodePresets.length > 0 ? sheet.gcodePresets : defaultSheet.gcodePresets
  const normalizedPresets = presets?.map((preset) => {
    const settings = { ...defaultSheet.gcodeSettings, ...preset.settings }
    if (settings.xyFeedRateMmPerSecond === undefined && settings.xyFeedRate !== undefined) {
      settings.xyFeedRateMmPerSecond = settings.xyFeedRate / 60
    }
    if (settings.cuttingFeedRateMmPerMinute === undefined && settings.xyFeedRateMmPerSecond !== undefined) {
      settings.cuttingFeedRateMmPerMinute = settings.xyFeedRateMmPerSecond * 60
    }
    if (settings.plungeFeedRateMmPerMinute === undefined) {
      settings.plungeFeedRateMmPerMinute = Math.min(settings.cuttingFeedRateMmPerMinute ?? 600, 600)
    }
    if (settings.rampFeedRateMmPerMinute === undefined) {
      settings.rampFeedRateMmPerMinute = settings.plungeFeedRateMmPerMinute
    }
    return { ...preset, settings }
  })

  return {
    ...defaultSheet,
    ...sheet,
    name: sheet.name?.trim() || defaultSheet.name,
    instances: sheet.instances.map((instance) => ({ ...instance, sheetIndex: instance.sheetIndex ?? 0 })),
    gcodeSettings,
    gcodePresets: normalizedPresets,
    defaultGcodePresetId: sheet.defaultGcodePresetId ?? defaultSheet.defaultGcodePresetId,
  }
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
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function sheetCountFor(sheet: Sheet): number {
  return Math.max(1, ...sheet.instances.map((instance) => instance.sheetIndex + 1))
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

function newItem(name = 'Untitled Item', uploadedBy?: string): MarketplaceItem {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    uploadedBy,
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

  if (project.items && project.items.length > 0) {
    const items = project.items.map(normalizeItem)
    const fallbackItemId = items[0].id
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
  const copy: PartInstance = { ...source, id: crypto.randomUUID() }
  const sourceBounds = instanceBounds(part, source)
  const copySize = {
    width: sourceBounds.maxX - sourceBounds.minX,
    height: sourceBounds.maxY - sourceBounds.minY,
  }
  const placed = sheet.instances
    .map((instance) => {
      const placedPart = parts.find((candidate) => candidate.id === instance.partId)
      if (instance.sheetIndex !== source.sheetIndex) return undefined
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

  const candidates = [...xs].flatMap((x) => [...ys].map((y) => ({ ...copy, sheetIndex: source.sheetIndex, x: Math.max(0, x), y: Math.max(0, y) })))
  candidates.sort((a, b) => Math.hypot(a.x - source.x, a.y - source.y) - Math.hypot(b.x - source.x, b.y - source.y))

  return candidates.find(isValid) ?? { ...copy, x: source.x + sheet.spacing + 10, y: source.y + sheet.spacing + 10 }
}

function App() {
  const initialState = useMemo(() => projectToAppState(loadProject()), [])
  const [page, setPage] = useState<'marketplace' | 'sheet' | 'history'>('marketplace')
  const [items, setItems] = useState<MarketplaceItem[]>(initialState.items)
  const [parts, setParts] = useState<Part[]>(initialState.parts)
  const [sheet, setSheet] = useState<Sheet>(normalizeSheet(initialState.sheet))
  const [activeSheetIndex, setActiveSheetIndex] = useState(0)
  const [sheetHistory, setSheetHistory] = useState<SheetHistoryEntry[]>(initialState.sheetHistory)
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(initialState.selectedItemId)
  const [selectedPartId, setSelectedPartId] = useState<string>()
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>()
  const [preview, setPreview] = useState<string>()
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

  const selectedInstance = sheet.instances.find((instance) => instance.id === selectedInstanceId)
  const selectedInstancePart = selectedInstance ? parts.find((part) => part.id === selectedInstance.partId) : undefined
  const selectedItem = items.find((item) => item.id === selectedItemId)
  const visibleParts = selectedItemId ? parts.filter((part) => part.itemId === selectedItemId) : []
  const sheetCount = sheetCountFor(sheet)
  const currentSheetIndex = Math.min(activeSheetIndex, sheetCount - 1)
  const issues = useMemo(() => validateSheet(parts, sheet), [parts, sheet])
  const errors = issues.filter((issue) => issue.level === 'error')
  const warnings = issues.filter((issue) => issue.level === 'warning')

  function canEditItem(item?: MarketplaceItem): boolean {
    return Boolean(item && (!item.ownerId || item.ownerId === userId))
  }

  async function requireAuthSession(): Promise<boolean> {
    if (!supabase) return false
    const sessionResult = await supabase.auth.getSession()
    if (sessionResult.data.session) {
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
    const hasSession = await requireAuthSession()
    if (!hasSession) return false

    const [aalResult, factorsResult] = await Promise.all([
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      supabase.auth.mfa.listFactors(),
    ])

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
    if (!userEmail || !mfaReady) return

    const timeout = window.setTimeout(() => {
      saveProject({ version: 1, items, parts, sheet, sheetHistory, savedAt: new Date().toISOString() })
      if (remoteHydratedRef.current && canUseSupabase()) {
        void saveRemoteProject(items, parts, sheet, selectedItemId).then((result) => {
          if (!result.ok) setStatus(`Cloud save failed: ${result.error ?? 'unknown error'}`)
        })
      }
    }, 300)

    return () => window.clearTimeout(timeout)
  }, [items, parts, selectedItemId, sheet, sheetHistory, userEmail, mfaReady])

  useEffect(() => {
    if (!canUseSupabase() || !userEmail || !mfaReady) return

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
        setSheetHistory(remoteProject.sheetHistory)
        if (remoteProject.sheet) {
          const remoteSheet = normalizeSheet(remoteProject.sheet)
          setSheet(pruneMissingSheetInstances({ ...remoteSheet, gcodePresets: mergePresets(remoteSheet.gcodePresets, remoteProject.gcodePresets) }, remoteProject.parts))
        } else {
          setSheet((current) => ({ ...current, gcodePresets: mergePresets(current.gcodePresets, remoteProject.gcodePresets) }))
        }
        setSelectedItemId(remoteProject.selectedItemId)
        setSelectedInstanceId(undefined)
        setActiveSheetIndex(0)
        setStatus('Loaded marketplace from Supabase.')
      } else {
        setStatus('Connected to Supabase. Marketplace is empty.')
      }
    })

    return () => {
      cancelled = true
    }
  }, [userEmail, mfaReady])

  useEffect(() => {
    if (!supabase) return

    void supabase.auth.getSession().then((result) => {
      setUserId(result.data.session?.user.id)
      setUserEmail(result.data.session?.user.email)
      if (result.data.session?.user.email) void refreshMfaState()
      setAuthReady(true)
    })

    const listener = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user.id)
      setUserEmail(session?.user.email)
      if (session?.user.email) void refreshMfaState()
      if (!session) {
        remoteHydratedRef.current = false
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
        setStatus('Signed out.')
        setUserId(undefined)
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
    await refreshMfaState()
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
    const targetItem = items.find((item) => item.id === itemId)
    if (!canEditItem(targetItem)) {
      setStatus('This shared item can be used on sheets, but only its owner can upload components.')
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
      imported.push(createPartFromGCode(file.name, gcode, dxfByStem.get(stem(file.name)), itemId))
    }

    setParts((current) => {
      const item = items.find((candidate) => candidate.id === itemId)
      const itemSku = item?.sku ?? 'ITEM'
      const existingCount = current.filter((part) => part.itemId === itemId).length
      const nextImported = imported.map((part, index) => normalizePart(part, itemSku, existingCount + index))
      return [...current, ...nextImported]
    })
    setItems((current) => current.map((item) => (item.id === itemId ? { ...item, updatedAt: new Date().toISOString() } : item)))
    setStatus(imported.length > 0 ? `Imported ${imported.length} component file(s).` : 'No supported G-code files found.')
  }

  function importFiles(fileList: FileList) {
    if (!selectedItemId) {
      const item = newItem('Imported Item', userEmail)
      setItems((current) => [...current, item])
      setSelectedItemId(item.id)
      void importFilesForItem(item.id, fileList)
      return
    }

    void importFilesForItem(selectedItemId, fileList)
  }

  function createMarketplaceItem() {
    const item = newItem(`Item ${items.length + 1}`, userEmail)
    setItems((current) => [...current, item])
    setSelectedItemId(item.id)
    setPage('marketplace')
    setStatus('Created new marketplace item.')
  }

  function updateMarketplaceItem(itemId: string, patch: Partial<MarketplaceItem>) {
    const targetItem = items.find((item) => item.id === itemId)
    if (!canEditItem(targetItem)) {
      setStatus('Only the owner can edit this shared item.')
      return
    }

    setItems((current) => current.map((item) => (item.id === itemId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item)))
  }

  function deleteComponent(partId: string) {
    const part = parts.find((candidate) => candidate.id === partId)
    const item = part?.itemId ? items.find((candidate) => candidate.id === part.itemId) : undefined
    if (!canEditItem(item)) {
      setStatus('Only the owner can remove components from this shared item.')
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
    setSheet((current) => ({
      ...current,
      instances: [...current.instances, newInstance(partId, x, y, currentSheetIndex)],
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

  function clearSheet() {
    setSheet((current) => ({ ...current, instances: [] }))
    setSelectedInstanceId(undefined)
    setActiveSheetIndex(0)
    setPreview(undefined)
    setStatus('Cleared placed parts from the sheet.')
  }

  function buildProject(): Project {
    return { version: 1, items, parts, sheet, sheetHistory, savedAt: new Date().toISOString() }
  }

  function buildHistoryEntry(): SheetHistoryEntry {
    const now = new Date()
    return {
      id: crypto.randomUUID(),
      name: sheet.name.trim() || `Sheet ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`,
      savedAt: now.toISOString(),
      sheet: normalizeSheet({ ...sheet, instances: sheet.instances.map((instance) => ({ ...instance })) }),
      selectedItemId,
      itemCount: items.length,
      componentCount: parts.length,
      placedCount: sheet.instances.length,
    }
  }

  async function saveCurrentProject(): Promise<boolean> {
    const historyEntry = buildHistoryEntry()
    const nextHistory = [historyEntry, ...sheetHistory]
    const localSaved = saveProject({ version: 1, items, parts, sheet, sheetHistory: nextHistory, savedAt: new Date().toISOString() })
    if (!localSaved) {
      setStatus('Could not save project; browser storage may be full.')
      return false
    }

    if (remoteHydratedRef.current && canUseSupabase()) {
      const remoteSaved = await saveRemoteProject(items, parts, sheet, selectedItemId)
      const historySaved = remoteSaved.ok ? await saveRemoteSheetHistory(historyEntry) : remoteSaved
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
    const loadedState = projectToAppState(loadProject())
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
    if (!file) return
    const project = JSON.parse(await readFile(file)) as Project
    const importedState = projectToAppState(project)
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
    const result = exportCombinedGCode(parts, sheet)
    setPreview(result.gcode)
    setStatus(result.errors.length > 0 ? `Preview generated with ${result.errors.length} export error(s).` : 'Preview generated from transformed G-code.')
  }

  async function exportGCode() {
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

    const saved = await saveCurrentProject()
    if (!saved) return
    const filename = `${filenameSafe(sheet.name)}.nc`
    downloadText(filename, result.gcode, 'application/x-gcode')
    setStatus(`Saved sheet and exported ${filename}.`)
  }

  async function exportAllSheetGCodes() {
    if (errors.length > 0) {
      setStatus('Export blocked by validation errors.')
      return
    }

    const results = exportPhysicalSheetGCodes(parts, sheet)
    const exportErrors = results.flatMap((result) => result.errors)
    if (exportErrors.length > 0) {
      setStatus('Export blocked by G-code transformation errors.')
      setPreview(results.map((result) => result.gcode).join('\n\n'))
      return
    }

    const saved = await saveCurrentProject()
    if (!saved) return
    const base = filenameSafe(sheet.name)
    results.forEach((result, index) => {
      window.setTimeout(() => {
        downloadText(`${base}-sheet-${result.sheetIndex + 1}.nc`, result.gcode, 'application/x-gcode')
      }, index * 150)
    })
    setStatus(`Saved sheet and exported ${results.length} sheet G-code file(s).`)
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
        </nav>
        <div className="sheet-controls">
          <label className="sheet-name-control">
            Sheet
            <input value={sheet.name} onChange={(event) => setSheet({ ...sheet, name: event.target.value })} />
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
        </div>
        <div className="toolbar-actions">
          <button
            type="button"
            onClick={() => {
              setSheet({ ...sheet, instances: autoNest(parts, sheet) })
              setActiveSheetIndex(0)
            }}
          >
            Auto Nest
          </button>
          <button type="button" onClick={clearSheet}>Clear Sheet</button>
          <button type="button" onClick={() => void saveCurrentProject()}>Save Sheet</button>
          <button type="button" onClick={loadSavedProject}>Load Sheet</button>
          <button type="button" onClick={previewGCode}>Preview</button>
          <button type="button" onClick={() => void exportAllSheetGCodes()}>Export Sheets</button>
          <button type="button" className="primary" onClick={() => void exportGCode()}>Export Combined</button>
          <button type="button" onClick={() => void signOut()}>Sign Out</button>
        </div>
      </header>

      {page === 'marketplace' ? (
        <MarketplacePage
          items={items}
          parts={parts}
          selectedItemId={selectedItemId}
          currentUserId={userId}
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
              parts={parts}
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
            <GCodeSettings
              settings={sheet.gcodeSettings}
              presets={sheet.gcodePresets ?? []}
              defaultPresetId={sheet.defaultGcodePresetId}
              onChange={(gcodeSettings) => setSheet({ ...sheet, gcodeSettings })}
              onLoadPreset={(preset) => setSheet({ ...sheet, gcodeSettings: { ...preset.settings } })}
              onSavePreset={(name) => {
                const preset: GCodePreset = { id: crypto.randomUUID(), name, uploadedBy: userEmail, settings: { ...sheet.gcodeSettings } }
                setSheet({ ...sheet, gcodePresets: [...(sheet.gcodePresets ?? []), preset] })
                if (canUseSupabase()) {
                  void saveRemoteGCodePreset(preset, userEmail).then((result) => {
                    if (!result.ok) setStatus(`Cloud preset save failed: ${result.error ?? 'unknown error'}`)
                  })
                }
              }}
              onSetDefaultPreset={(presetId) => {
                const preset = sheet.gcodePresets?.find((candidate) => candidate.id === presetId)
                setSheet({
                  ...sheet,
                  defaultGcodePresetId: presetId,
                  gcodeSettings: preset ? { ...preset.settings } : sheet.gcodeSettings,
                })
              }}
              onDeletePreset={(presetId) => {
                setSheet({
                  ...sheet,
                  gcodePresets: (sheet.gcodePresets ?? []).filter((preset) => preset.id !== presetId),
                  defaultGcodePresetId: sheet.defaultGcodePresetId === presetId ? undefined : sheet.defaultGcodePresetId,
                })
                void deleteRemoteGCodePreset(presetId)
              }}
            />
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
