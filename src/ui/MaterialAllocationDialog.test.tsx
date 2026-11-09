import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaterialAllocationDialog } from './MaterialAllocationDialog'
import { MaterialEditor } from './MaterialEditor'
import { addition, hex, materialPart, materialSheet, natural } from '../test/materialFixtures'
import { testItem } from '../test/jobFixtures'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false })
})
afterEach(cleanup)

describe('material planning controls', () => {
  it('opens above an existing modal and leaves that modal open when cancelled', () => {
    const parent = document.createElement('dialog')
    document.body.append(parent)
    parent.showModal()
    const onApply = vi.fn(), onCancel = vi.fn(), part = materialPart('panel')
    const view = render(<MaterialAllocationDialog name="Order #1007" parts={[part]} sheet={materialSheet()} additions={[addition(part.id)]} startIndex={0} onApply={onApply} onCancel={onCancel} />)
    const allocation = screen.getByRole('dialog', { name: 'Allocate item materials' })
    expect(allocation).toBeInstanceOf(HTMLDialogElement)
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenLastCalledWith()
    expect(allocation).toHaveAttribute('open')
    expect(screen.getByRole('radio', { name: /Allocate every part/ })).toHaveFocus()
    const event = new Event('cancel', { cancelable: true })
    fireEvent(allocation, event)
    expect(event.defaultPrevented).toBe(true)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onApply).not.toHaveBeenCalled()
    view.unmount()
    expect(allocation).not.toHaveAttribute('open')
    expect(parent.open).toBe(true)
    parent.remove()
  })
  it('previews the full item or just matching parts and commits only on Add parts', () => {
    const parts = [materialPart('panel'), materialPart('hex', hex)], onApply = vi.fn(), onCancel = vi.fn()
    render(<MaterialAllocationDialog name="Cabinet" parts={parts} sheet={materialSheet()} additions={parts.map(p => addition(p.id))} startIndex={0} onApply={onApply} onCancel={onCancel} />)
    expect(screen.getByText('2 parts allocated · 0 awaiting allocation · 2 total')).toBeInTheDocument()
    expect(screen.getByText('12 mm Plywood · Black Hex')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Add matching parts/ }))
    expect(screen.getByText('1 parts allocated · 1 awaiting allocation · 2 total')).toBeInTheDocument()
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Add parts' }))
    expect(onApply.mock.calls[0][0].instances).toHaveLength(1)
    expect(onApply.mock.calls[0][0].pendingParts).toHaveLength(1)
  })
  it('keeps cancellation free of sheet changes', () => {
    const sheet = materialSheet(), onApply = vi.fn(), onCancel = vi.fn(), part = materialPart('panel')
    render(<MaterialAllocationDialog name="Cabinet" parts={[part]} sheet={sheet} additions={[addition(part.id)]} startIndex={0} onApply={onApply} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onApply).not.toHaveBeenCalled()
    expect(sheet.instances).toEqual([])
  })
  it('saves an item default and explicit component finish together', async () => {
    const save = vi.fn(async () => {}), parts = [materialPart('Front'), materialPart('Back')]
    render(<MaterialEditor item={{ ...testItem, defaultMaterial: natural }} parts={parts} readOnly={false} onSave={save} />)
    fireEvent.click(screen.getByText('Part material overrides (2 parts)'))
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Use a different material' })[0])
    fireEvent.change(screen.getByLabelText('Front finish'), { target: { value: 'Black hex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save materials' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(natural, { Front: hex, Back: null }))
  })
})
