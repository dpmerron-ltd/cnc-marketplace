import type { PackingSettings } from '../packing/types'

export interface MarketplaceItem {
  id: string
  ownerId?: string
  uploadedBy?: string
  sku: string
  name: string
  description: string
  createdAt: string
  updatedAt: string
  packing?: PackingSettings
}
