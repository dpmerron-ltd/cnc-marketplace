import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrdersPage } from './OrdersPage'
import { jobApiRequest } from '../storage/jobsApi'

vi.mock('../storage/jobsApi', () => ({ jobApiRequest: vi.fn() }))
const request = vi.mocked(jobApiRequest)
const pageInfo = { hasNextPage: false, endCursor: null }
const line = { id: 'line1', title: 'Universal rack', sku: 'VS-0003', variantTitle: '12 mm', quantity: 2, currentQuantity: 1, unfulfilledQuantity: 1 }
const order = { id: 'gid://shopify/Order/123', name: '#1001', lineItems: { nodes: [line], pageInfo } }
const reply = (body: unknown) => ({ json: async () => body }) as Response
beforeEach(() => { request.mockReset().mockImplementation(async (path, owner) => {
  if (path === '/shopify/connection') return reply({ accountId: owner, connected: owner === 'alice', ...(owner === 'alice' ? { shop: 'test.myshopify.com' } : {}) })
  if (path.startsWith('/shopify/orders/')) return reply({ shop: 'test.myshopify.com', fetchedAt: '2026-09-21', order })
  return reply({ shop: 'test.myshopify.com', fetchedAt: '2026-09-21', orders: [order], pageInfo: { hasNextPage: true, endCursor: 'next-page' } })
}) })
afterEach(cleanup)
describe('Shopify orders page', () => {
  it('shows only order numbers and ordered items with no financial columns', async () => {
    render(<OrdersPage userId="alice" />)
    fireEvent.click(await screen.findByRole('button', { name: '#1001' }))
    expect(await screen.findByRole('columnheader', { name: 'Ordered' })).toBeInTheDocument()
    expect(screen.getAllByText('VS-0003').length).toBeGreaterThan(0)
    expect(screen.getByText('Current quantity: 1')).toBeInTheDocument()
    expect(screen.queryByText(/price|total|payment|£/i)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Shopify' })).toHaveAttribute('href', 'https://test.myshopify.com/admin/orders/123')
    expect(request).toHaveBeenCalledWith('/shopify/orders/123', 'alice', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })
  it('paginates orders, resets pagination on filters and refreshes details', async () => {
    render(<OrdersPage userId="alice" />)
    await screen.findByRole('button', { name: '#1001' })
    fireEvent.click(screen.getByRole('button', { name: 'Next orders' }))
    await waitFor(() => expect(request.mock.calls.some(([path]) => path.includes('after=next-page'))).toBe(true))
    await screen.findByText('Page 2')
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'all' } })
    await screen.findByText('Page 1')
    expect(request.mock.calls.at(-1)?.[0]).toBe('/shopify/orders?status=all')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Order number' }), { target: { value: '#1001' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search orders' }))
    await waitFor(() => expect(request.mock.calls.at(-1)?.[0]).toContain('search=%231001'))
  })
  it('clears private data on account change and ignores a stale request', async () => {
    let resolve!: (response: Response) => void
    request.mockImplementationOnce(async () => reply({ accountId: 'alice', connected: true, shop: 'private.myshopify.com' })).mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const view = render(<OrdersPage key="alice" userId="alice" />)
    await waitFor(() => expect(resolve).toBeDefined())
    view.rerender(<OrdersPage key="bob" userId="bob" />)
    await screen.findByText('No Shopify store connected to this account.')
    await act(async () => resolve(reply({ orders: [order], pageInfo, shop: 'private.myshopify.com' })))
    expect(screen.queryByText('#1001')).not.toBeInTheDocument()
    expect(screen.queryByText('private.myshopify.com')).not.toBeInTheDocument()
  })
  it('shows failures without presenting stale orders as fresh results', async () => {
    render(<OrdersPage userId="alice" />)
    await screen.findByRole('button', { name: '#1001' })
    request.mockRejectedValueOnce(new Error('Shopify rate limit reached. Retry shortly.'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh orders' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('rate limit')
    expect(screen.queryByRole('button', { name: '#1001' })).not.toBeInTheDocument()
  })
})
