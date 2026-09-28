import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { MarketplaceItem } from '../models/Item'
import { MarketplacePage } from './MarketplacePage'
import { createPartFromGCode } from '../gcode/importPart'
vi.mock('./ItemDocuments', () => ({ ItemDocuments: ({ readOnly }: { readOnly: boolean }) => <div>{readOnly ? 'Read-only documents' : 'Editable documents'}</div> }))
vi.mock('../storage/useBoxStock', () => ({ useBoxStock: () => ({ boxes: undefined }) }))
vi.mock('./ItemPreview', () => ({ ItemPreview: () => <div /> }))
vi.mock('./PackingPanel', () => ({ PackingPanel: () => <div /> }))
afterEach(() => cleanup())
const previous: MarketplaceItem = { id: 'a', name: 'Rack', sku: 'RACK', description: '', createdAt: '', updatedAt: '', version: { familyId: 'a', number: 1, status: 'published', isDefault: false } }
const current: MarketplaceItem = { ...previous, id: 'b', version: { ...previous.version!, number: 2, isDefault: true } }
const parts = [previous, current].map(item => ({ ...createPartFromGCode('Side.nc', 'G21\nG90\nG0 Z20\nG0 X0 Y0\nG1 Z-2 F600\nG1 X50 Y50\nG0 Z20\nM30', undefined, item.id), name: 'Side' }))
const callbacks = () => ({ onCreateItem: vi.fn(() => ''), onSelectItem: vi.fn(), onUpdateItem: vi.fn(), onSaveImage: vi.fn(), onImportComponents: vi.fn(), onDeleteComponent: vi.fn(), onAddToSheet: vi.fn(), onAddItemToSheet: vi.fn(() => 1), onOpenSheet: vi.fn() })

it('keeps the default editable and the older version read-only with its original components', () => {
  const actions = callbacks()
  render(<MarketplacePage items={[previous, current]} parts={parts} currentUserId="user" {...actions} />)
  expect(screen.getAllByRole('button', { name: 'Open Rack' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Open Rack' }))
  expect(screen.getByLabelText('Item version')).toHaveValue('b')
  expect(screen.getByLabelText('Item name')).not.toHaveAttribute('readonly')
  expect(screen.queryByRole('button', { name: 'Publish version' })).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Item version'), { target: { value: 'a' } })
  expect(screen.getByLabelText('Item name')).toHaveAttribute('readonly')
  expect(screen.queryByLabelText('Upload components')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Remove Side' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Add to sheet' }))
  expect(actions.onAddToSheet).toHaveBeenCalledWith(parts[0].id)
  expect(screen.getByText('Read-only documents')).toBeInTheDocument()
})

it('follows automatic revisions while editing but keeps a deliberately selected historical version', () => {
  const actions = callbacks(), view = render(<MarketplacePage items={[previous, current]} parts={parts} currentUserId="user" {...actions} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open Rack' }))
  fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Revised rack' } })
  expect(actions.onUpdateItem).toHaveBeenCalledWith('b', { name: 'Revised rack' })
  const next = { ...current, id: 'c', name: 'Revised rack', version: { ...current.version!, number: 3 } }
  const revisions = [previous, { ...current, version: { ...current.version!, isDefault: false } }, next]
  view.rerender(<MarketplacePage items={revisions} parts={parts} currentUserId="user" {...actions} />)
  expect(screen.getByLabelText('Item version')).toHaveValue('c')
  expect(screen.getByLabelText('Item name')).toHaveValue('Revised rack')
  fireEvent.change(screen.getByLabelText('Item version'), { target: { value: 'a' } })
  view.rerender(<MarketplacePage items={revisions} parts={parts} currentUserId="user" {...actions} />)
  expect(screen.getByLabelText('Item version')).toHaveValue('a')
})
