import type { MarketplaceItem } from '../models/Item'
import type { ComponentSummary, Part } from '../models/Part'
import { itemImageSchema } from '../models/ItemImage'
import type { PackingSettings } from '../packing/types'

export interface VersionItemRow {
  id: string; owner_id: string; uploaded_by: string; sku: string; name: string; description: string
  created_at: string; updated_at: string; packing: PackingSettings; image: unknown
  version_family_id: string; version_number: number; version_status: 'draft' | 'published'; version_default: boolean; published_at: string | null
}
export interface VersionComponentRow {
  id: string; owner_id: string; item_id: string; sku: string; name: string; original_filename: string
  width: number; height: number; component_family_id: string; component_source_id: string | null; material_profile?: string
}
export interface VersionUpdateResult { changed: boolean; current: VersionItemRow; previous: VersionItemRow | null; components: VersionComponentRow[] }
export interface CatalogueChange {
  userId: string; current: MarketplaceItem; previous?: MarketplaceItem
  components: (ComponentSummary & { sourceId?: string })[]
  submittedItem?: MarketplaceItem; parts: Part[]
}
export function versionItem(row: VersionItemRow): MarketplaceItem {
  const image = itemImageSchema.safeParse(row.image)
  return { id: row.id, ownerId: row.owner_id, uploadedBy: row.uploaded_by, sku: row.sku, name: row.name, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at, packing: row.packing, image: image.success ? image.data : null,
    version: { familyId: row.version_family_id, number: row.version_number, status: row.version_status, isDefault: row.version_default, publishedAt: row.published_at ?? undefined } }
}
const listeners = new Set<(change: CatalogueChange) => void>()
export function subscribeCatalogueChanges(listener: (change: CatalogueChange) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export function emitCatalogueChange(change: CatalogueChange): void { for (const listener of listeners) listener(change) }

export function mergeVersionEdit(change: CatalogueChange, local?: MarketplaceItem): MarketplaceItem {
  const next = { ...change.current }
  const submitted = change.submittedItem ?? change.previous
  if (!local || !submitted) return next
  for (const field of ['name', 'sku', 'description', 'packing'] as const) {
    if (JSON.stringify(local[field]) !== JSON.stringify(submitted[field])) Object.assign(next, { [field]: local[field] })
  }
  if (next.packing?.components && next.packing !== change.current.packing) {
    const ids = new Map(change.components.filter(part => part.sourceId).map(part => [part.sourceId!, part.id]))
    next.packing = { ...next.packing, components: Object.fromEntries(Object.entries(next.packing.components).map(([id, value]) => [ids.get(id) ?? id, value])) }
  }
  return next
}
