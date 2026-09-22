import type { ComponentSummary, Part } from './Part'
import type { Sheet } from './Sheet'
import type { MarketplaceItem } from './Item'

export interface SheetHistoryEntry {
  id: string
  name: string
  savedAt: string
  sheet: Sheet
  selectedItemId?: string
  itemCount: number
  componentCount: number
  placedCount: number
}

export interface Project {
  version: 1
  items?: MarketplaceItem[]
  parts: Part[]
  componentIndex?: ComponentSummary[]
  sheet: Sheet
  sheetHistory?: SheetHistoryEntry[]
  savedAt: string
}
