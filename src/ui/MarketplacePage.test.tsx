import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketplaceItem } from '../models/Item'
import { createPartFromGCode } from '../gcode/importPart'
import { MarketplacePage } from './MarketplacePage'
import { testImage } from '../test/imageFixture'

vi.mock('./ItemPreview', () => ({ ItemPreview: ({ label }: { label: string }) => <div role="img" aria-label={label} /> }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })
const item = (id: string, name: string, ownerId = 'alice'): MarketplaceItem => ({ id, name, ownerId, sku: `SKU-${id}`, description: `${name} description`, createdAt: '2026-09-01', updatedAt: id === 'b' ? '2026-09-17' : '2026-09-02' })
const items = [item('a', 'Alpha cabinet'), item('b', 'Beta locker'), item('empty', 'Empty item'), item('private', 'Private item', 'bob')]
const part = (name: string, itemId: string, ownerId = 'alice') => ({ ...createPartFromGCode(`${name}.nc`, 'G21\nG90\nG00 Z20\nG00 X0 Y0\nG01 Z-2 F600\nG01 X50 Y50\nG00 Z20\nM30', undefined, itemId), name, ownerId })
const parts = [part('Side panel', 'a'), part('Door', 'b'), part('Base', 'b'), part('Secret component', 'a', 'bob')]
function setup() {
  const callbacks = { onCreateItem: vi.fn(() => 'new'), onSelectItem: vi.fn(), onUpdateItem: vi.fn(), onSaveImage: vi.fn(async () => {}), onImportComponents: vi.fn(), onDeleteComponent: vi.fn(), onAddToSheet: vi.fn(), onAddItemToSheet: vi.fn(() => 2), onOpenSheet: vi.fn() }
  const view = render(<MarketplacePage items={items} parts={parts} currentUserId="alice" {...callbacks} />)
  return { ...callbacks, ...view }
}

describe('item library grid', () => {
  it('shows item images in the grid, with upload controls for a newly created item', () => {
    const callbacks = setup()
    callbacks.rerender(<MarketplacePage items={[{ ...items[0], image: testImage }, ...items.slice(1)]} parts={parts} currentUserId="alice" {...callbacks} />)
    expect(screen.getByRole('img', { name: 'Alpha cabinet' })).toHaveAttribute('src', expect.stringContaining('data:image/png'))
    expect(screen.queryByRole('img', { name: 'Alpha cabinet components' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New item' }))
    callbacks.rerender(<MarketplacePage items={[...items, item('new', 'New cabinet')]} parts={parts} currentUserId="alice" {...callbacks} />)
    expect(screen.getByLabelText('Upload item image')).toBeEnabled()
  })
  it('adds an entire item, disables empty items and shows placement failures', () => {
    const callbacks = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Open Beta locker' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add all to sheet' }))
    expect(callbacks.onAddItemToSheet).toHaveBeenCalledExactlyOnceWith('b')
    expect(screen.getByText('2 components from Beta locker added to the sheet.')).toBeInTheDocument()
    callbacks.onAddItemToSheet.mockImplementationOnce(() => { throw new Error('Panel does not fit') })
    fireEvent.click(screen.getByRole('button', { name: 'Add all to sheet' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Panel does not fit')
    fireEvent.click(screen.getByRole('button', { name: 'All items' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open Empty item' }))
    expect(screen.getByRole('button', { name: 'Add all to sheet' })).toBeDisabled()
  })
  it('shows only the account library and searches names, SKUs and component files', () => {
    setup()
    expect(screen.getAllByRole('button', { name: /^Open / })).toHaveLength(3)
    expect(screen.queryByText('Private item')).not.toBeInTheDocument()
    const search = screen.getByRole('textbox', { name: 'Search items' })
    fireEvent.change(search, { target: { value: 'side panel.nc' } })
    expect(screen.getByRole('button', { name: 'Open Alpha cabinet' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Beta locker' })).not.toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'SKU-b' } })
    expect(screen.getByRole('button', { name: 'Open Beta locker' })).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'Secret component' } })
    expect(screen.getByText('No matching items')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(search).toHaveValue('')
    expect(screen.getAllByRole('button', { name: /^Open / })).toHaveLength(3)
  })
  it('sorts and filters without mutating the underlying library', () => {
    setup()
    fireEvent.change(screen.getByLabelText('Sort items'), { target: { value: 'components' } })
    expect(screen.getAllByRole('button', { name: /^Open / })[0]).toHaveAccessibleName('Open Beta locker')
    fireEvent.change(screen.getByLabelText('Sort items'), { target: { value: 'updated' } })
    expect(screen.getAllByRole('button', { name: /^Open / })[0]).toHaveAccessibleName('Open Beta locker')
    fireEvent.change(screen.getByLabelText('Filter items'), { target: { value: 'empty' } })
    expect(screen.getAllByRole('button', { name: /^Open / })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Open Empty item' })).toBeInTheDocument()
    expect(items.map(i => i.id)).toEqual(['a', 'b', 'empty', 'private'])
  })
  it('opens details, edits metadata, uploads and adds components without leaving the item', () => {
    const callbacks = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha cabinet' }))
    expect(callbacks.onSelectItem).toHaveBeenCalledWith('a')
    expect(screen.queryByText('Secret component')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Renamed cabinet' } })
    expect(callbacks.onUpdateItem).toHaveBeenCalledWith('a', { name: 'Renamed cabinet' })
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'cab-1' } })
    expect(callbacks.onUpdateItem).toHaveBeenCalledWith('a', { sku: 'CAB-1' })
    const files = [new File(['G21'], 'panel.nc')]
    fireEvent.change(screen.getByLabelText('Upload components'), { target: { files } })
    expect(callbacks.onImportComponents).toHaveBeenCalledWith('a', files)
    fireEvent.click(screen.getByRole('button', { name: 'Add to sheet' }))
    expect(callbacks.onAddToSheet).toHaveBeenCalledWith(parts[0].id)
    expect(screen.getByText('Side panel added to the sheet.')).toBeInTheDocument()
    expect(callbacks.onOpenSheet).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open sheet' }))
    expect(callbacks.onOpenSheet).toHaveBeenCalledOnce()
  })
  it('preserves grid search on return and confirms component removal', () => {
    const callbacks = setup()
    fireEvent.change(screen.getByLabelText('Search items'), { target: { value: 'Alpha' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha cabinet' }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Side panel' }))
    expect(callbacks.onDeleteComponent).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Side panel' }))
    expect(callbacks.onDeleteComponent).toHaveBeenCalledWith(parts[0].id)
    fireEvent.click(screen.getByRole('button', { name: 'All items' }))
    expect(screen.getByLabelText('Search items')).toHaveValue('Alpha')
  })
  it('opens newly created items and never falls back to another account item', () => {
    const callbacks = setup()
    fireEvent.click(screen.getByRole('button', { name: 'New item' }))
    expect(callbacks.onCreateItem).toHaveBeenCalledOnce()
    callbacks.rerender(<MarketplacePage items={[...items, item('new', 'New cabinet')]} parts={parts} currentUserId="alice" {...callbacks} />)
    expect(screen.getByLabelText('Item name')).toHaveValue('New cabinet')
    callbacks.rerender(<MarketplacePage items={items} parts={parts} currentUserId="bob" {...callbacks} />)
    expect(screen.queryByLabelText('Item name')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Private item' })).toBeInTheDocument()
  })
})
