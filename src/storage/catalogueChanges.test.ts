import { expect, it } from 'vitest'
import { mergeVersionEdit, type CatalogueChange } from './catalogueChanges'
import type { MarketplaceItem } from '../models/Item'
const previous: MarketplaceItem = { id: 'one', name: 'A', sku: 'SKU', description: '', createdAt: '', updatedAt: '', version: { familyId: 'one', number: 1, status: 'published', isDefault: false } }
const current: MarketplaceItem = { ...previous, id: 'two', name: 'B', version: { ...previous.version!, number: 2, isDefault: true } }
const change: CatalogueChange = { userId: 'alice', previous, current, components: [], parts: [], submittedItem: { ...previous, name: 'B' } }
it('keeps typing made while an earlier automatic save was running', () => {
  const result = mergeVersionEdit(change, { ...previous, name: 'C' })
  expect(result).toMatchObject({ id: 'two', name: 'C', version: { number: 2, isDefault: true } })
  expect(previous.name).toBe('A')
})
it('accepts saved values and does not roll them back on an identical retry', () => {
  expect(mergeVersionEdit(change, { ...previous, name: 'B' })).toEqual(current)
  expect(mergeVersionEdit(change, current)).toEqual(current)
})
