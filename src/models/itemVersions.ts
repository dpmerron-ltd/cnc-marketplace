import type { MarketplaceItem } from './Item'

export function itemFamily(item: MarketplaceItem): string { return item.version?.familyId ?? item.id }
export function editableItem(item: MarketplaceItem): boolean { return !item.version || item.version.isDefault }
export function defaultItem(item: MarketplaceItem): boolean { return !item.version || item.version.isDefault }
export function versionLabel(item: MarketplaceItem): string {
  if (!item.version) return 'Version 1'
  return `Version ${item.version.number}${item.version.status === 'draft' ? ' (draft)' : item.version.isDefault ? ' (default)' : ' (previous)'}`
}

export function catalogueItems(items: MarketplaceItem[]): MarketplaceItem[] {
  const families = new Map<string, MarketplaceItem>()
  for (const item of items) {
    const key = itemFamily(item), previous = families.get(key)
    if (!previous || defaultItem(item) || (!defaultItem(previous) && (item.version?.number ?? 1) > (previous.version?.number ?? 1))) families.set(key, item)
  }
  return [...families.values()]
}
