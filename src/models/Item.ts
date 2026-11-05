import type { PackingSettings } from '../packing/types'
import type { ItemImage } from './ItemImage'
import type { StockMaterial } from './stockMaterial'

export interface MarketplaceItem {
  defaultMaterial?: StockMaterial
  id: string
  ownerId?: string
  uploadedBy?: string
  sku: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  packing?: PackingSettings
  image?: ItemImage | null
  /** Historical image omitted from startup; fetch before a full backup. */
  imageDeferred?: boolean
  version?: {
    familyId: string
    number: number
    status: 'draft' | 'published'
    isDefault: boolean
    publishedAt?: string
  }
}
