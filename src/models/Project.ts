import type { Part } from './Part'
import type { Sheet } from './Sheet'
import type { MarketplaceItem } from './Item'

export interface Project {
  version: 1
  items?: MarketplaceItem[]
  parts: Part[]
  sheet: Sheet
  savedAt: string
}
