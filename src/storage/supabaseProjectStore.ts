import { createPartFromGCode } from '../gcode/importPart'
import type { MarketplaceItem } from '../models/Item'
import { itemImageSchema, type ItemImage } from '../models/ItemImage'
import type { ComponentSummary, Part } from '../models/Part'
import type { SheetHistoryEntry } from '../models/Project'
import type { GCodePreset, Sheet } from '../models/Sheet'
import { isSupabaseConfigured, supabase } from './supabaseClient'
import { materialProfiles, materialVariantsSchema } from '../cam/materialProfiles'

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
    return { ok: false, error: 'The component must belong to an item in your signed-in account.' }
  }
  // The item's ownership is also enforced by the database's component RLS policy.
  const result = await supabase.from('cnc_components').upsert([componentRow(part)])
  return result.error ? { ok: false, error: result.error.message } : { ok: true }
}

export async function saveRemoteItemImage(item: MarketplaceItem, image: ItemImage | null, expectedUserId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured.')
  if (image) itemImageSchema.parse(image)
  const userId = await getUserId()
  if (!userId || userId !== expectedUserId || item.ownerId !== userId) throw new Error('The item must belong to your signed-in account.')
  // New items may not have reached the debounced autosave yet. Never overwrite an existing row here.
  const created = await supabase.from('marketplace_items').upsert({
    id: item.id, owner_id: userId, uploaded_by: item.uploadedBy ?? '', sku: item.sku,
    name: item.name, description: item.description, created_at: item.createdAt, updated_at: item.updatedAt,
    packing: item.packing ?? {},
  }, { onConflict: 'id', ignoreDuplicates: true })
  if (created.error) throw new Error(created.error.message)
  if (await getUserId() !== expectedUserId) throw new Error('Your account changed. Please reload.')
  const result = await supabase.from('marketplace_items').update({ image, updated_at: new Date().toISOString() }).eq('id', item.id).eq('owner_id', userId).select('id').single()
  if (result.error) throw new Error(result.error.message)
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
    readLibraryPages((from, to) => client.from('marketplace_items').select('*').eq('owner_id', userId).order('created_at').order('id').range(from, to), 'items', onProgress),
    readLibraryPages((from, to) => client.from('cnc_components').select('id,owner_id,item_id,sku,name,original_filename,width,height,material_profile:material_variants->>primaryProfile').eq('owner_id', userId).order('id').range(from, to), 'component index', onProgress, 500),
    supabase.from('sheet_projects').select('*').eq('owner_id', userId).eq('id', userId).maybeSingle<ProjectRow>(),
    supabase.from('sheet_history').select('*').eq('owner_id', userId).order('saved_at', { ascending: false }),
    supabase.from('gcode_presets').select('*').eq('owner_id', userId).order('name'),
  ])

  const stateError = presetsResult.error ?? projectResult.error ?? historyResult.error
  if (stateError) throw new Error(`Could not load your saved library settings: ${stateError.message}`)

  const items: MarketplaceItem[] = itemRows.filter((row) => row.owner_id === userId).map((row) => ({
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
  }))

  const itemSkuById = new Map(items.map((item) => [item.id, item.sku]))
  const componentIndex: ComponentSummary[] = componentRows.filter(row => row.owner_id === userId && itemSkuById.has(row.item_id)).map(row => ({
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
  if (!supabase || item.ownerId !== expectedUserId || await getUserId() !== expectedUserId) throw new Error('Your account changed. Please reload.')
  const client = supabase
  const rows = await readLibraryPages<ComponentRow>((from, to) => client.from('cnc_components')
    .select('id,owner_id,item_id,sku,name,original_filename,gcode,dxf,date_imported,material_variants')
    .eq('owner_id', expectedUserId).eq('item_id', item.id).order('date_imported').order('id').range(from, to), 'item components')
  if (await getUserId() !== expectedUserId) throw new Error('Your account changed. Please reload.')
  const parts: Part[] = []
  for (const [index, row] of rows.entries()) {
    if (row.owner_id !== expectedUserId || row.item_id !== item.id) continue
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

export async function saveRemoteProject(items: MarketplaceItem[], parts: Part[], sheet: Sheet, selectedItemId: string | undefined, expectedUserId: string): Promise<RemoteSaveResult> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' }
  const userId = await getUserId()
  if (!userId || userId !== expectedUserId) return { ok: false, error: 'The signed-in account changed. Please reload.' }

  const saveableItems = items.filter((item) => item.ownerId === userId)
  const itemIds = new Set(saveableItems.map((item) => item.id))
  const saveableParts = parts.filter((part) => part.ownerId === userId && itemIds.has(part.itemId ?? ''))
  if (saveableItems.length !== items.length || saveableParts.length !== parts.length) {
    return { ok: false, error: 'Cannot save items or components belonging to another account.' }
  }
  if (saveableItems.length > 0) {
    const itemsResult = await supabase.from('marketplace_items').upsert(
      saveableItems.map((item) => ({
        id: item.id,
        owner_id: userId,
        uploaded_by: item.uploadedBy ?? '',
        sku: item.sku,
        name: item.name,
        description: item.description,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
        packing: item.packing ?? {},
      })),
    )
    if (itemsResult.error) {
      console.warn('Supabase item save failed.', itemsResult.error)
      return { ok: false, error: itemsResult.error.message }
    }
  }

  // Sheet autosaves may carry stale programs from before an API correction.
  // Insert new imports only; existing programs are changed through revision-checked API writes.
  for (const group of [saveableParts.filter(part => !part.metadata.materialVariants), saveableParts.filter(part => part.metadata.materialVariants)]) {
    if (!group.length) continue
    const componentsResult = await supabase.from('cnc_components').upsert(
      group.map(componentRow),
      { onConflict: 'id', ignoreDuplicates: true },
    )
    if (componentsResult.error) {
      console.warn('Supabase component save failed.', componentsResult.error)
      return { ok: false, error: componentsResult.error.message }
    }
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

export async function deleteRemoteComponent(partId: string): Promise<void> {
  if (!supabase) return
  const userId = await getUserId()
  if (!userId) return
  const result = await supabase.from('cnc_components').delete().eq('id', partId).eq('owner_id', userId)
  if (result.error) console.warn('Supabase component delete failed.', result.error)
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
