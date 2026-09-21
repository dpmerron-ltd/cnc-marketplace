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
  if (path === '/shopify/connection') return reply({ accountId: owner, isOrderAdmin: owner === 'alice', connected: owner === 'alice', ...(owner === 'alice' ? { shop: 'test.myshopify.com' } : {}) })
  if (path.startsWith('/shopify/users')) return reply({ users: [{ id: 'bob', email: 'bob@example.com' }], nextOffset: null })
  if (path.startsWith('/shopify/orders/')) return reply({ shop: 'test.myshopify.com', fetchedAt: '2026-09-21', order })
  return reply({ shop: 'test.myshopify.com', fetchedAt: '2026-09-21', orders: [order], pageInfo: { hasNextPage: true, endCursor: 'next-page' } })
}) })
afterEach(cleanup)
describe('Shopify orders page', () => {
  it('lets the admin assign a fixed fee in pence, then unassign without retaining the fee', async () => {
    const base = request.getMockImplementation()!
    const assignee = { order_id: '123', assignee_id: 'bob', assignee_email: 'bob@example.com', payment_pence: 4567, currency: 'GBP', version: 1, updated_at: '2026-09-21' }
    request.mockImplementation(async (...args) => args[0].endsWith('/assignment') ? reply({ assignment: JSON.parse(String(args[2]?.body)).assigneeId ? assignee : { ...assignee, assignee_id: null, assignee_email: null, payment_pence: null, version: 2 } }) : base(...args))
    render(<OrdersPage userId="alice" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Assign #1001' }))
    await screen.findByRole('option', { name: 'bob@example.com' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Assigned to' }), { target: { value: 'bob' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Cutting payment (GBP / order)' }), { target: { value: '45.67' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save assignment' }))
    await screen.findByText('Assignment saved.')
    const patch = request.mock.calls.find(([, , init]) => init?.method === 'PATCH')!
    expect(JSON.parse(String(patch[2]?.body))).toEqual({ assigneeId: 'bob', paymentPence: 4567, expectedVersion: 0 })
    expect(screen.getByText('£45.67')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save assignment' })).toBeEnabled())
    fireEvent.change(screen.getByRole('combobox', { name: 'Assigned to' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save assignment' }))
    await waitFor(() => expect(screen.queryByText('£45.67')).not.toBeInTheDocument())
    const patches = request.mock.calls.filter(([, , init]) => init?.method === 'PATCH')
    expect(JSON.parse(String(patches.at(-1)![2]?.body))).toEqual({ assigneeId: null, paymentPence: null, expectedVersion: 1 })
  })
  it('shows workers their fee without assignment controls, other users or a Shopify admin link', async () => {
    const assignment = { payment_pence: 4500, currency: 'GBP', assignee_id: 'bob', version: 1 }
    request.mockImplementation(async path => {
      if (path === '/shopify/connection') return reply({ accountId: 'bob', connected: true, isOrderAdmin: false, shop: 'test.myshopify.com' })
      if (path === '/shopify/orders/123') return reply({ shop: 'test.myshopify.com', order: { ...order, assignment } })
      return reply({ shop: 'test.myshopify.com', fetchedAt: '2026-09-21', orders: [{ ...order, assignment }], pageInfo })
    })
    render(<OrdersPage userId="bob" />)
    fireEvent.click(await screen.findByRole('button', { name: '#1001' }))
    await screen.findByRole('columnheader', { name: 'Ordered' })
    expect(screen.getAllByText('£45.00').length).toBeGreaterThan(0)
    expect(screen.queryByRole('form', { name: 'Order assignment' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Shopify' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument()
    expect(request.mock.calls.some(([path]) => path.includes('/users'))).toBe(false)
  })
  it('reports a stale assignment conflict without changing the displayed fee', async () => {
    const base = request.getMockImplementation()!
    request.mockImplementation(async (...args) => { if (args[0].endsWith('/assignment')) throw new Error('Assignment or payment changed. Reload the order before saving again.'); return base(...args) })
    render(<OrdersPage userId="alice" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Assign #1001' }))
    await screen.findByRole('option', { name: 'bob@example.com' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Assigned to' }), { target: { value: 'bob' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Cutting payment (GBP / order)' }), { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save assignment' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Assignment or payment changed')
    expect(screen.queryByText('Assignment saved.')).not.toBeInTheDocument()
    expect(screen.queryByText('£25.00')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reload assignment' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
  it('shows only order numbers and ordered items with no financial columns', async () => {
    render(<OrdersPage userId="alice" />)
    fireEvent.click(await screen.findByRole('button', { name: '#1001' }))
    expect(await screen.findByRole('columnheader', { name: 'Ordered' })).toBeInTheDocument()
    expect(screen.getAllByText('VS-0003').length).toBeGreaterThan(0)
    expect(screen.getByText('Current quantity: 1')).toBeInTheDocument()
    expect(screen.queryByText(/order value|total price|subtotal/i)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Shopify' })).toHaveAttribute('href', 'https://test.myshopify.com/admin/orders/123')
    expect(request).toHaveBeenCalledWith('/shopify/orders/123', 'alice', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })
  it('paginates orders, resets pagination on filters and refreshes details', async () => {
    render(<OrdersPage userId="alice" />)
    await screen.findByRole('button', { name: '#1001' })
    fireEvent.click(screen.getByRole('button', { name: 'Next orders' }))
    await waitFor(() => expect(request.mock.calls.some(([path]) => path.includes('after=next-page'))).toBe(true))
    await screen.findByText('Page 2')
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'open' } })
    await screen.findByText('Page 1')
    expect(request.mock.calls.at(-1)?.[0]).toBe('/shopify/orders?status=open')
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
