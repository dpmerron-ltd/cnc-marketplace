import { describe, expect, it } from 'vitest'
import type { MarketplaceItem } from './Item'
import { catalogueItems, defaultItem, editableItem, versionLabel } from './itemVersions'

const revision = (id: string, number: number, status: 'draft' | 'published', isDefault = false): MarketplaceItem => ({ id, name: 'Rack', sku: 'RACK', description: '', createdAt: '', updatedAt: '', version: { familyId: 'rack', number, status, isDefault } })
describe('item revisions', () => {
  it('uses one default per product, not its newer unfinished draft', () => {
    const previous = revision('one', 1, 'published'), current = revision('two', 2, 'published', true), draft = revision('three', 3, 'draft')
    expect(catalogueItems([draft, previous, current])).toEqual([current])
    expect(catalogueItems([current, draft, previous])).toEqual([current])
    expect(defaultItem(previous)).toBe(false)
    expect(editableItem(current)).toBe(true)
    expect(editableItem(previous)).toBe(false)
    expect(editableItem(draft)).toBe(false)
    expect(versionLabel(draft)).toBe('Version 3 (draft)')
  })
  it('shows a brand-new draft without making it a cutting default', () => {
    const draft = revision('one', 1, 'draft')
    expect(catalogueItems([draft])).toEqual([draft])
    expect(defaultItem(draft)).toBe(false)
  })
})
