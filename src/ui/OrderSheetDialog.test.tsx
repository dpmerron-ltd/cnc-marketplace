import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderSheetDialog } from './OrderSheetDialog'
import { jobApiRequest } from '../storage/jobsApi'
import { testItem, testParts } from '../test/jobFixtures'

vi.mock('../storage/jobsApi', () => ({ jobApiRequest: vi.fn() }))
const request = vi.mocked(jobApiRequest)
const item = { ...testItem, ownerId: 'alice', sku: 'VS-0003' }
const parts = testParts.map(part => ({ ...part, itemId: item.id, ownerId: 'alice' }))
const pageInfo = { hasNextPage: false, endCursor: null }
const line = { id: 'line1', title: 'Rack', sku: 'VS-0003', quantity: 2, currentQuantity: 2, unfulfilledQuantity: 1 }
const order = { id: 'gid://shopify/Order/7', name: '#1007', lineItems: { nodes: [line], pageInfo } }
const reply = (value: unknown) => ({ json: async () => value }) as Response
const props = () => ({ userId: 'alice', orderId: '7', items: [item], parts, sheetName: 'Current sheet', onAdd: vi.fn().mockResolvedValue(undefined), onClose: vi.fn() })
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true })
  request.mockReset().mockResolvedValue(reply({ shop: 'test.myshopify.com', order }))
})
afterEach(cleanup)
describe('order sheet confirmation', () => {
  it('matches VS-0003, shows full component quantity and submits the complete order', async () => {
    const p = props(); render(<OrderSheetDialog {...p} />)
    expect(await screen.findByRole('combobox')).toHaveValue(item.id)
    expect(screen.getByRole('status')).toHaveTextContent('4 components')
    fireEvent.click(screen.getByRole('button', { name: 'Add components' }))
    await waitFor(() => expect(p.onAdd).toHaveBeenCalledOnce())
    expect(p.onAdd.mock.calls[0][0]).toEqual({ shop: 'test.myshopify.com', order, matches: { line1: item.id } })
    await waitFor(() => expect(p.onClose).toHaveBeenCalledOnce())
  })
  it('loads all item pages before enabling addition, not only the order preview', async () => {
    request.mockResolvedValueOnce(reply({ shop: 'test.myshopify.com', order: { ...order, lineItems: { nodes: [line], pageInfo: { hasNextPage: true, endCursor: 'next' } } } })).mockResolvedValueOnce(reply({ shop: 'test.myshopify.com', order: { ...order, lineItems: { nodes: [{ ...line, id: 'line2', title: 'Second rack' }], pageInfo } } }))
    render(<OrderSheetDialog {...props()} />)
    expect(await screen.findByText('2 x Second rack')).toBeInTheDocument()
    expect(request.mock.calls[1][0]).toBe('/shopify/orders/7?after=next')
    expect(screen.getByRole('status')).toHaveTextContent('8 components')
  })
  it('requires explicit selection for ambiguous SKUs and excludes other accounts', async () => {
    const p = props(); p.items.push({ ...item, id: 'duplicate', name: 'Fresh rack' }, { ...item, ownerId: 'bob', id: 'foreign', name: 'Private item' })
    render(<OrderSheetDialog {...p} />)
    const select = await screen.findByRole('combobox')
    expect(select).toHaveValue('')
    expect(screen.queryByRole('option', { name: /Private item/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add components' })).toBeDisabled()
    fireEvent.change(select, { target: { value: item.id } })
    expect(screen.getByRole('button', { name: 'Add components' })).toBeEnabled()
  })
  it('fails closed on missing pages and supports retry', async () => {
    request.mockRejectedValueOnce(new Error('Could not load order'))
    render(<OrderSheetDialog {...props()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load')
    expect(screen.queryByRole('button', { name: 'Add components' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('combobox')).toHaveValue(item.id)
  })
  it('blocks double submission, reports errors, and aborts work on close/unmount', async () => {
    let reject!: (error: Error) => void
    const p = props(); p.onAdd.mockImplementation(() => new Promise((_resolve, r) => { reject = r }))
    const view = render(<OrderSheetDialog {...p} />)
    await screen.findByRole('combobox')
    const button = screen.getByRole('button', { name: 'Add components' })
    fireEvent.click(button); fireEvent.click(button)
    expect(p.onAdd).toHaveBeenCalledOnce()
    expect(screen.getByRole('status')).toHaveTextContent('Nesting 0/4')
    await act(async () => reject(new Error('Missing material variant')))
    expect(screen.getByRole('alert')).toHaveTextContent('Missing material')
    fireEvent.click(button)
    const signal = p.onAdd.mock.calls[1][1] as AbortSignal
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => reject(new Error('Cancelled')))
  })
})
