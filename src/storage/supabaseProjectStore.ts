import { createPartFromGCode } from '../gcode/importPart'
import type { MarketplaceItem } from '../models/Item'
import { itemImageSchema, type ItemImage } from '../models/ItemImage'
import type { ComponentSummary, Part } from '../models/Part'
import type { SheetHistoryEntry } from '../models/Project'
import type { GCodePreset, Sheet } from '../models/Sheet'
import { isSupabaseConfigured, supabase } from './supabaseClient'
import { materialProfiles, materialVariantsSchema } from '../cam/materialProfiles'
import { editableItem, itemFamily } from '../models/itemVersions'
import { emitCatalogueChange, versionItem, type VersionUpdateResult } from './catalogueChanges'

interface ComponentRow {
  id: string
  owner_id: string
  item_id: string
  sku: string | null
  name: string
  original_filename: string
  gcode: string
  dxf: string | null
  date_imported: string
  material_variants?: unknown
}

interface ProjectRow {
  id: string
  sheet: Sheet
  selected_item_id: string | null
}

interface SheetHistoryRow {
  id: string
  name: string
  saved_at: string
  sheet: Sheet
  selected_item_id: string | null
  item_count: number
  component_count: number
  placed_count: number
}

interface GCodePresetRow {
  id: string
  owner_id: string
  uploaded_by: string
  name: string
  settings: GCodePreset['settings']
}

export interface RemoteProjectState {
  items: MarketplaceItem[]
  parts: Part[]
  componentIndex?: ComponentSummary[]
  sheet?: Sheet
  selectedItemId?: string
  sheetHistory: SheetHistoryEntry[]
  gcodePresets: GCodePreset[]
}

export interface RemoteSaveResult {
  ok: boolean
  error?: string
  part?: Part
}

export function canUseSupabase(): boolean {
  return isSupabaseConfigured && Boolean(supabase)
}

function componentRow(part: Part) {
  const { materialVariants, ...metadata } = part.metadata
  return {
    id: part.id, owner_id: part.ownerId, item_id: part.itemId, sku: part.sku, name: part.name,
    original_filename: part.originalFilename, gcode: part.gcode, dxf: part.dxf ?? null,
    width: part.width, height: part.height, bounding_box: part.boundingBox,
    original_bounds: part.originalBounds, metadata, date_imported: part.dateImported,
    ...(materialVariants ? { material_variants: materialVariants } : {}),
  }
}

export async function saveRemoteComponent(part: Part, expectedUserId: string): Promise<RemoteSaveResult> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' }
  const userId = await getUserId()
  if (!userId || userId !== expectedUserId || part.ownerId !== userId || !part.itemId) {
    return { ok: false, error: 'New components must be attributed to your current session and linked to a shared item.' }
  }
  // New components are attributed to their creator; the parent item is shared.
  try {
    const result = await updateRemoteItem(userId, part.itemId, 'add_components', { components: [componentRow(part)] }, undefined, [part])
    const saved = result.components.find(component => component.component_family_id === part.id)
    return { ok: true, part: { ...part, id: saved?.id ?? part.id, itemId: result.current.id } }
  } catch (error) { return { ok: false, error: (error as Error).message } }
}

export async function saveRemoteItemImage(item: MarketplaceItem, image: ItemImage | null, expectedUserId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured.')
  if (image) itemImageSchema.parse(image)
  const userId = await getUserId()
  if (!userId || userId !== expectedUserId) throw new Error('The signed-in account changed. Please reload.')
  // Save new item metadata first, without ever reassigning an existing creator.
  const saved = await saveCatalogueItem(item, userId)
  if (!saved.ok) throw new Error(saved.error)
  if (await getUserId() !== expectedUserId) throw new Error('Your account changed. Please reload.')
  await updateRemoteItem(userId, itemFamily(item), 'image', { image, expected: item.image ?? null })
}

async function getUserId(): Promise<string | undefined> {
  if (!supabase) return undefined
  const result = await supabase.auth.getUser()
  return result.data.user?.id
}

function skuBase(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function fallbackItemSku(id: string, name: string): string {
  return `${skuBase(name) || 'ITEM'}-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`
}

function fallbackComponentSku(id: string, itemSku: string): string {
  return `${skuBase(itemSku) || 'ITEM'}-C${id.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase()}`
}

// Bound both response size and concurrency: component rows contain full NC variants.
async function readLibraryPages<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, label: string, onProgress?: (message: string) => void, pageSize = 25): Promise<T[]> {
  const rows: T[] = []
  const concurrency = 3
  for (let offset = 0; ; offset += pageSize * concurrency) {
    const pages = await Promise.all(Array.from({ length: concurrency }, (_, index) => fetchPage(offset + index * pageSize, offset + (index + 1) * pageSize - 1)))
    for (const page of pages) {
      if (page.error) throw new Error(`Could not load ${label}: ${page.error.message}`)
      rows.push(...(page.data ?? []))
      if ((page.data?.length ?? 0) < pageSize) {
        onProgress?.(`Loaded ${rows.length} ${label}.`)
        return rows
      }
    }
    onProgress?.(`Loading ${label}: ${rows.length} loaded…`)
  }
}

export async function loadRemoteProject(expectedUserId: string, onProgress?: (message: string) => void): Promise<RemoteProjectState | undefined> {
  if (!supabase) return undefined
  const userId = await getUserId()
  if (!userId || userId !== expectedUserId) return undefined

  const client = supabase
  const [itemRows, componentRows, projectResult, historyResult, presetsResult] = await Promise.all([
    readLibraryPages((from, to) => client.from('marketplace_items').select('*').order('created_at').order('id').range(from, to), 'items', onProgress),
    readLibraryPages((from, to) => client.from('cnc_components').select('id,owner_id,item_id,sku,name,original_filename,width,height,material_profile:material_variants->>primaryProfile').order('id').range(from, to), 'component index', onProgress, 500),
    supabase.from('sheet_projects').select('*').eq('owner_id', userId).eq('id', userId).maybeSingle<ProjectRow>(),
    supabase.from('sheet_history').select('*').eq('owner_id', userId).order('saved_at', { ascending: false }),
    supabase.from('gcode_presets').select('*').eq('owner_id', userId).order('name'),
  ])

  const stateError = presetsResult.error ?? projectResult.error ?? historyResult.error
  if (stateError) throw new Error(`Could not load your saved library settings: ${stateError.message}`)

  const items: MarketplaceItem[] = itemRows.map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    uploadedBy: row.uploaded_by ?? undefined,
    sku: row.sku ?? fallbackItemSku(row.id, row.name),
    name: row.name,
    description: row.description ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    packing: row.packing ?? undefined,
    image: itemImageSchema.safeParse(row.image).success ? row.image : undefined,
    ...(row.version_family_id ? { version: { familyId: row.version_family_id, number: row.version_number, status: row.version_status, isDefault: row.version_default, publishedAt: row.published_at ?? undefined } } : {}),
  }))

  if (await getUserId() !== expectedUserId) return undefined
  catalogueSnapshots.set(userId, new Map(items.map(item => [item.id, structuredClone(item)])))

  const itemSkuById = new Map(items.map((item) => [item.id, item.sku]))
  const componentIndex: ComponentSummary[] = componentRows.filter(row => itemSkuById.has(row.item_id)).map(row => ({
    id: row.id, ownerId: row.owner_id, itemId: row.item_id,
    sku: row.sku ?? fallbackComponentSku(row.id, itemSkuById.get(row.item_id)!), name: row.name,
    originalFilename: row.original_filename, width: row.width, height: row.height,
    ...(materialProfiles.some(profile => profile.id === row.material_profile) ? { materialThicknessMm: materialProfiles.find(profile => profile.id === row.material_profile)!.thickness } : {}),
  }))

  const project = projectResult.error ? undefined : projectResult.data
  const gcodePresets: GCodePreset[] = ((presetsResult.data ?? []) as GCodePresetRow[]).map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    uploadedBy: row.uploaded_by,
    name: row.name,
    settings: row.settings,
  }))
  const sheetHistory: SheetHistoryEntry[] = historyResult.error
    ? []
    : ((historyResult.data ?? []) as SheetHistoryRow[]).map((row) => ({
        id: row.id,
        name: row.name,
        savedAt: row.saved_at,
        sheet: row.sheet,
        selectedItemId: row.selected_item_id ?? undefined,
        itemCount: row.item_count,
        componentCount: row.component_count,
        placedCount: row.placed_count,
      }))

  return {
    items,
    parts: [],
    componentIndex,
    sheet: project?.sheet,
    selectedItemId: project?.selected_item_id ?? items[0]?.id,
    sheetHistory,
    gcodePresets,
  }
}

export async function loadRemoteItemComponents(item: MarketplaceItem, expectedUserId: string): Promise<Part[]> {
  if (!supabase || await getUserId() !== expectedUserId) throw new Error('Your account changed. Please reload.')
  const client = supabase
  const rows = await readLibraryPages<ComponentRow>((from, to) => client.from('cnc_components')
    .select('id,owner_id,item_id,sku,name,original_filename,gcode,dxf,date_imported,material_variants')
    .eq('item_id', item.id).order('date_imported').order('id').range(from, to), 'item components')
  if (await getUserId() !== expectedUserId) throw new Error('Your account changed. Please reload.')
  const parts: Part[] = []
  for (const [index, row] of rows.entries()) {
    if (row.item_id !== item.id) continue
    if (index % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0))
    const part = createPartFromGCode(row.original_filename, row.gcode, row.dxf ?? undefined, item.id)
    if (row.material_variants != null) {
      const variants = materialVariantsSchema.safeParse(row.material_variants)
      if (!variants.success) throw new Error(`${row.sku ?? row.name}: saved cutting profiles could not be read. No components have been removed.`)
      part.metadata.materialVariants = variants.data
    }
    parts.push({ ...part, id: row.id, ownerId: row.owner_id, sku: row.sku ?? fallbackComponentSku(row.id, item.sku), name: row.name, dateImported: row.date_imported })
  }
  return parts
}

// Snapshots are per login; only changed metadata is written. Sheet autosaves
// must not replace another user's newer catalogue edits with their cached copy.
const catalogueSnapshots = new Map<string, Map<string, MarketplaceItem>>()
function editableMetadata(item: MarketplaceItem) {
  return { sku: item.sku, name: item.name, description: item.description, packing: item.packing ?? {} }
}
let catalogueWriteQueue: Promise<RemoteSaveResult> = Promise.resolve({ ok: true })
const componentSuccessors = new Map<string, string>()
function currentPacking(packing: MarketplaceItem['packing']) {
  if (!packing?.components) return packing ?? {}
  return { ...packing, components: Object.fromEntries(Object.entries(packing.components).map(([id, value]) => {
    let current = id
    const visited = new Set<string>()
    while (componentSuccessors.has(current) && !visited.has(current)) { visited.add(current); current = componentSuccessors.get(current)! }
    return [current, value]
  })) }
}
export function updateRemoteItem(userId: string, itemId: string, action: string, payload: unknown, submittedItem?: MarketplaceItem, parts: Part[] = []): Promise<VersionUpdateResult> {
  const next = catalogueWriteQueue.then(() => applyItemUpdate(userId, itemId, action, payload, submittedItem, parts))
  catalogueWriteQueue = next.then(() => ({ ok: true }), error => ({ ok: false, error: String(error) }))
  return next
}
async function applyItemUpdate(userId: string, itemId: string, action: string, payload: unknown, submittedItem?: MarketplaceItem, parts: Part[] = []): Promise<VersionUpdateResult> {
  if (!supabase || await getUserId() !== userId) throw new Error('Your account changed. Reload before saving.')
  const response = await supabase.rpc('update_item_version', { p_actor: userId, p_item: itemId, p_action: action, p_payload: payload })
  if (response.error) throw new Error(response.error.message.includes('CONFLICT') ? 'This item changed in another session. Reload before saving your changes.' : response.error.message)
  const result = response.data as VersionUpdateResult
  if (!result?.current?.id || !Array.isArray(result.components)) throw new Error('The saved version could not be confirmed. Reload the catalogue.')
  if (await getUserId() !== userId) throw new Error('Your account changed. Reload to see the saved version.')
  const current = versionItem(result.current), previous = result.previous ? versionItem(result.previous) : undefined
  const snapshots = catalogueSnapshots.get(userId) ?? new Map<string, MarketplaceItem>()
  if (previous) snapshots.set(previous.id, structuredClone(previous))
  snapshots.set(current.id, structuredClone(current)); catalogueSnapshots.set(userId, snapshots)
  for (const part of result.components) if (part.component_source_id) componentSuccessors.set(part.component_source_id, part.id)
  emitCatalogueChange({ userId, current, previous, submittedItem, parts, components: result.components.map(part => ({ id: part.id, ownerId: part.owner_id, itemId: part.item_id, sku: part.sku, name: part.name, originalFilename: part.original_filename, width: part.width, height: part.height, sourceId: part.component_source_id ?? undefined, materialThicknessMm: materialProfiles.find(profile => profile.id === part.material_profile)?.thickness })) })
  return result
}
export function saveCatalogueItem(item: MarketplaceItem, userId: string): Promise<RemoteSaveResult> {
  const next = catalogueWriteQueue.then(() => persistCatalogueItem(item, userId))
  catalogueWriteQueue = next.catch(error => ({ ok: false, error: String(error) }))
  return next
}
async function persistCatalogueItem(item: MarketplaceItem, userId: string): Promise<RemoteSaveResult> {
  if (await getUserId() !== userId) return { ok: false, error: 'The signed-in account changed. Please reload.' }

  const snapshots = catalogueSnapshots.get(userId) ?? new Map<string, MarketplaceItem>()
  catalogueSnapshots.set(userId, snapshots)
  const previous = snapshots.get(item.id)
  if (!previous) {
    if (item.ownerId !== userId) return { ok: false, error: 'Reload the shared catalogue before editing this item.' }
    const result = await supabase!.from('marketplace_items').upsert([{
      id: item.id, owner_id: userId, uploaded_by: item.uploadedBy ?? '',
      ...editableMetadata(item), created_at: item.createdAt, updated_at: item.updatedAt,
    }], { onConflict: 'id', ignoreDuplicates: true }).select('id')
    if (result.error) return { ok: false, error: result.error.message }
    // Ignore-duplicates protects existing IDs (including items deleted/recreated
    // in another session). Never treat a collided ID as a successful insertion.
    if (!result.data?.length) return { ok: false, error: 'Item already exists. Reload the shared catalogue before editing it.' }
  } else {
    if (JSON.stringify(editableMetadata(previous)) === JSON.stringify(editableMetadata(item))) return { ok: true }
    if (item.version && !item.version.isDefault) return { ok: false, error: 'Previous versions are read-only.' }
    const latest = [...snapshots.values()].find(value => itemFamily(value) === itemFamily(item) && editableItem(value)) ?? previous
    try { await applyItemUpdate(userId, itemFamily(item), 'metadata', { expected: editableMetadata(latest), next: { ...editableMetadata(item), packing: currentPacking(item.packing) } }, item) }
    catch (error) { return { ok: false, error: (error as Error).message } }
    return { ok: true }
  }
  snapshots.set(item.id, structuredClone(item))
  return { ok: true }
}

let projectSaveQueue: Promise<RemoteSaveResult> = Promise.resolve({ ok: true })
export function saveRemoteProject(...args: Parameters<typeof persistRemoteProject>): Promise<RemoteSaveResult> {
  const next = projectSaveQueue.then(() => persistRemoteProject(...args))
  projectSaveQueue = next.catch(error => ({ ok: false, error: String(error) }))
  return next
}

async function persistRemoteProject(items: MarketplaceItem[], parts: Part[], sheet: Sheet, selectedItemId: string | undefined, expectedUserId: string): Promise<RemoteSaveResult> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' }
  const userId = await getUserId()
  if (!userId || userId !== expectedUserId) return { ok: false, error: 'The signed-in account changed. Please reload.' }

  const itemIds = new Set(items.map(item => item.id))
  if (parts.some(part => !itemIds.has(part.itemId ?? ''))) return { ok: false, error: 'A component is missing its catalogue item.' }
  // Existing shared programs are never rewritten by sheet autosave.
  const saveableParts = parts.filter(part => part.ownerId === userId)
  const snapshots = catalogueSnapshots.get(userId)
  const changedItems = items.filter(item => {
    const previous = snapshots?.get(item.id)
    return !previous || JSON.stringify(editableMetadata(previous)) !== JSON.stringify(editableMetadata(item))
  })
  for (const item of changedItems) {
    const result = await saveCatalogueItem(item, userId)
    if (!result.ok) return result
  }

  // Sheet autosaves may carry stale programs from before an API correction.
  // Insert new imports only; existing programs are changed through revision-checked API writes.
  for (const itemId of new Set(saveableParts.map(part => part.itemId!))) {
    const group = saveableParts.filter(part => part.itemId === itemId)
    try { await updateRemoteItem(userId, itemId, 'add_components', { components: group.map(componentRow) }, undefined, group) }
    catch (error) { return { ok: false, error: (error as Error).message } }
  }

  const projectResult = await supabase.from('sheet_projects').upsert({
    id: userId,
    owner_id: userId,
    sheet,
    selected_item_id: itemIds.has(selectedItemId ?? '') ? selectedItemId : null,
    updated_at: new Date().toISOString(),
  })

  if (projectResult.error) {
    console.warn('Supabase project save failed.', projectResult.error)
    return { ok: false, error: projectResult.error.message }
  }

  return { ok: true }
}

export async function deleteRemoteComponent(partId: string, expectedUserId?: string, itemId?: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured.')
  const userId = await getUserId()
  if (!userId || (expectedUserId && expectedUserId !== userId)) throw new Error('Your account changed. Reload before deleting components.')
  if (!itemId) throw new Error('The item is required to create a revised version.')
  await updateRemoteItem(userId, itemId, 'remove_component', { id: partId })
}

export async function saveRemoteSheetHistory(entry: SheetHistoryEntry, expectedUserId: string): Promise<RemoteSaveResult> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' }
  const userId = await getUserId()
  if (!userId || userId !== expectedUserId) return { ok: false, error: 'The signed-in account changed. Please reload.' }

  const result = await supabase.from('sheet_history').upsert({
    id: entry.id,
    owner_id: userId,
    name: entry.name,
    saved_at: entry.savedAt,
    sheet: entry.sheet,
    selected_item_id: entry.selectedItemId ?? null,
    item_count: entry.itemCount,
    component_count: entry.componentCount,
    placed_count: entry.placedCount,
  })

  if (result.error) return { ok: false, error: result.error.message }
  return { ok: true }
}

export async function deleteRemoteSheetHistory(entryId: string): Promise<void> {
  if (!supabase) return
  const userId = await getUserId()
  if (!userId) return
  const result = await supabase.from('sheet_history').delete().eq('id', entryId).eq('owner_id', userId)
  if (result.error) console.warn('Supabase sheet history delete failed.', result.error)
}

export async function saveRemoteGCodePreset(preset: GCodePreset, uploadedBy?: string): Promise<RemoteSaveResult> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' }
  const userId = await getUserId()
  if (!userId) return { ok: false, error: 'You are not signed in.' }

  const result = await supabase.from('gcode_presets').upsert({
    id: preset.id,
    owner_id: userId,
    uploaded_by: preset.uploadedBy ?? uploadedBy ?? '',
    name: preset.name,
    settings: preset.settings,
    updated_at: new Date().toISOString(),
  })

  if (result.error) return { ok: false, error: result.error.message }
  return { ok: true }
}

export async function deleteRemoteGCodePreset(presetId: string): Promise<void> {
  if (!supabase) return
  const userId = await getUserId()
  if (!userId) return
  const result = await supabase.from('gcode_presets').delete().eq('id', presetId).eq('owner_id', userId)
  if (result.error) console.warn('Supabase G-code preset delete failed.', result.error)
}
