import { createPartFromGCode } from '../gcode/importPart'
import type { MarketplaceItem } from '../models/Item'
import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import { isSupabaseConfigured, supabase } from './supabaseClient'

interface ComponentRow {
  id: string
  item_id: string
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

export interface RemoteProjectState {
  items: MarketplaceItem[]
  parts: Part[]
  sheet?: Sheet
  selectedItemId?: string
}

export interface RemoteSaveResult {
  ok: boolean
  error?: string
}

export function canUseSupabase(): boolean {
  return isSupabaseConfigured && Boolean(supabase)
}

async function getUserId(): Promise<string | undefined> {
  if (!supabase) return undefined
  const result = await supabase.auth.getUser()
  return result.data.user?.id
}

export async function loadRemoteProject(): Promise<RemoteProjectState | undefined> {
  if (!supabase) return undefined
  const userId = await getUserId()
  if (!userId) return undefined

  const [itemsResult, componentsResult, projectResult] = await Promise.all([
    supabase.from('marketplace_items').select('*').eq('owner_id', userId).order('created_at'),
    supabase.from('cnc_components').select('*').eq('owner_id', userId).order('date_imported'),
    supabase.from('sheet_projects').select('*').eq('id', userId).maybeSingle<ProjectRow>(),
  ])

  if (itemsResult.error || componentsResult.error) {
    console.warn('Supabase load failed. Has the schema been created?', itemsResult.error ?? componentsResult.error)
    return undefined
  }

  const items: MarketplaceItem[] = (itemsResult.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))

  const parts: Part[] = ((componentsResult.data ?? []) as ComponentRow[]).map((row) => {
    const part = createPartFromGCode(row.original_filename, row.gcode, row.dxf ?? undefined, row.item_id)
    return {
      ...part,
      id: row.id,
      name: row.name,
      dateImported: row.date_imported,
    }
  })

  const project = projectResult.error ? undefined : projectResult.data

  return {
    items,
    parts,
    sheet: project?.sheet,
    selectedItemId: project?.selected_item_id ?? items[0]?.id,
  }
}

export async function saveRemoteProject(items: MarketplaceItem[], parts: Part[], sheet: Sheet, selectedItemId?: string): Promise<RemoteSaveResult> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' }
  const userId = await getUserId()
  if (!userId) return { ok: false, error: 'You are not signed in.' }

  if (items.length > 0) {
    const itemsResult = await supabase.from('marketplace_items').upsert(
      items.map((item) => ({
        id: item.id,
        owner_id: userId,
        name: item.name,
        description: item.description,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })),
    )
    if (itemsResult.error) {
      console.warn('Supabase item save failed.', itemsResult.error)
      return { ok: false, error: itemsResult.error.message }
    }
  }

  const saveableParts = parts.filter((part) => part.itemId)
  if (saveableParts.length > 0) {
    const componentsResult = await supabase.from('cnc_components').upsert(
      saveableParts.map((part) => ({
        id: part.id,
        owner_id: userId,
        item_id: part.itemId,
        name: part.name,
        original_filename: part.originalFilename,
        gcode: part.gcode,
        dxf: part.dxf ?? null,
        width: part.width,
        height: part.height,
        bounding_box: part.boundingBox,
        original_bounds: part.originalBounds,
        metadata: part.metadata,
        date_imported: part.dateImported,
      })),
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
    selected_item_id: selectedItemId ?? null,
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
