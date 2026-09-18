import { createPartFromGCode } from '../gcode/importPart'
import type { MarketplaceItem } from '../models/Item'
import type { Part } from '../models/Part'
import type { SheetHistoryEntry } from '../models/Project'
import type { GCodePreset, Sheet } from '../models/Sheet'
import { isSupabaseConfigured, supabase } from './supabaseClient'

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
  return {
    id: part.id, owner_id: part.ownerId, item_id: part.itemId, sku: part.sku, name: part.name,
    original_filename: part.originalFilename, gcode: part.gcode, dxf: part.dxf ?? null,
    width: part.width, height: part.height, bounding_box: part.boundingBox,
    original_bounds: part.originalBounds, metadata: part.metadata, date_imported: part.dateImported,
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

export async function loadRemoteProject(expectedUserId: string): Promise<RemoteProjectState | undefined> {
  if (!supabase) return undefined
  const userId = await getUserId()
  if (!userId || userId !== expectedUserId) return undefined

  const [itemsResult, componentsResult, projectResult, historyResult, presetsResult] = await Promise.all([
    supabase.from('marketplace_items').select('*').eq('owner_id', userId).order('created_at'),
    supabase.from('cnc_components').select('*').eq('owner_id', userId).order('date_imported'),
    supabase.from('sheet_projects').select('*').eq('owner_id', userId).eq('id', userId).maybeSingle<ProjectRow>(),
    supabase.from('sheet_history').select('*').eq('owner_id', userId).order('saved_at', { ascending: false }),
    supabase.from('gcode_presets').select('*').eq('owner_id', userId).order('name'),
  ])

  if (itemsResult.error || componentsResult.error || presetsResult.error || projectResult.error || historyResult.error) {
    console.warn('Supabase load failed. Has the schema been created?', itemsResult.error ?? componentsResult.error ?? presetsResult.error)
    return undefined
  }

  const items: MarketplaceItem[] = (itemsResult.data ?? []).filter((row) => row.owner_id === userId).map((row) => ({
    id: row.id,
    ownerId: row.owner_id,
    uploadedBy: row.uploaded_by ?? undefined,
    sku: row.sku ?? fallbackItemSku(row.id, row.name),
    name: row.name,
    description: row.description ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    packing: row.packing ?? undefined,
  }))

  const itemSkuById = new Map(items.map((item) => [item.id, item.sku]))
  const parts: Part[] = ((componentsResult.data ?? []) as ComponentRow[]).filter((row) => row.owner_id === userId && itemSkuById.has(row.item_id)).map((row) => {
    const part = createPartFromGCode(row.original_filename, row.gcode, row.dxf ?? undefined, row.item_id)
    const itemSku = itemSkuById.get(row.item_id) ?? 'ITEM'
    return {
      ...part,
      id: row.id,
      ownerId: row.owner_id,
      sku: row.sku ?? fallbackComponentSku(row.id, itemSku),
      name: row.name,
      dateImported: row.date_imported,
    }
  })

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
    parts,
    sheet: project?.sheet,
    selectedItemId: project?.selected_item_id ?? items[0]?.id,
    sheetHistory,
    gcodePresets,
  }
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

  if (saveableParts.length > 0) {
    const componentsResult = await supabase.from('cnc_components').upsert(
      saveableParts.map(componentRow),
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
