import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OrderDocumentsDialog } from './OrderDocumentsDialog'
const mocks = vi.hoisted(() => ({ load: vi.fn(), list: vi.fn(), packet: vi.fn(), download: vi.fn() }))
vi.mock('../orders/loadCompleteOrder', () => ({ loadCompleteOrder: mocks.load }))
vi.mock('../storage/itemDocumentsStore', () => ({ listItemDocuments: mocks.list, downloadItemDocument: mocks.download }))
vi.mock('../documents/itemDocuments', async original => ({ ...await original<typeof import('../documents/itemDocuments')>(), createPrintPacket: mocks.packet }))
const item = { id: 'i', ownerId: 'alice', name: 'Rack', sku: 'VS-3', description: '', createdAt: '', updatedAt: '' }
const doc = { id: 'd', item_id: 'i', owner_id: 'alice', kind: 'instructions', filename: 'manual.pdf', pages: 2 }
beforeEach(() => {
  vi.clearAllMocks()
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  URL.createObjectURL = vi.fn(() => 'blob:test'); URL.revokeObjectURL = vi.fn()
  mocks.load.mockResolvedValue({ order: { name: '#1007', lineItems: { nodes: [{ id: 'l', title: 'Rack', sku: 'VS-3', currentQuantity: 2 }, { id: 'refunded', title: 'Refunded', sku: 'VS-3', currentQuantity: 0 }] } } })
  mocks.list.mockResolvedValue([doc]); mocks.packet.mockResolvedValue(new Blob(['pdf']))
})
afterEach(cleanup)
it('matches SKU, defaults to current quantities and shows missing documents', async () => {
  render(<OrderDocumentsDialog userId="alice" orderId="123" items={[item]} onClose={() => {}} />)
  expect(await screen.findByText('Rack: packing list not uploaded.')).toBeInTheDocument()
  expect(screen.queryByText('Refunded')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Copies of manual.pdf for Rack')).toHaveValue(2)
  fireEvent.click(screen.getByRole('button', { name: 'Prepare print PDF' }))
  expect(await screen.findByRole('link', { name: 'Open / print PDF' })).toHaveAttribute('href', 'blob:test')
  expect(mocks.packet).toHaveBeenCalledWith([expect.objectContaining({ document: doc, copies: 2 })], expect.any(Function))
  fireEvent.change(screen.getByLabelText('Copies of manual.pdf for Rack'), { target: { value: '1' } })
  expect(screen.queryByRole('link', { name: 'Open / print PDF' })).not.toBeInTheDocument()
})
it('requires manual matching for duplicate SKUs', async () => {
  render(<OrderDocumentsDialog userId="alice" orderId="123" items={[item, { ...item, id: 'other' }]} onClose={() => {}} />)
  expect(await screen.findByText('Rack: catalogue item not selected.')).toBeInTheDocument()
  expect(mocks.list).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Prepare print PDF' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Document item for Rack'), { target: { value: 'i' } })
  expect(await screen.findByLabelText('Copies of manual.pdf for Rack')).toHaveValue(2)
})
it('shows download failures without offering an incomplete packet', async () => {
  mocks.packet.mockRejectedValue(new Error('PDF unavailable'))
  render(<OrderDocumentsDialog userId="alice" orderId="123" items={[item]} onClose={() => {}} />)
  await screen.findByLabelText('Copies of manual.pdf for Rack')
  fireEvent.click(screen.getByRole('button', { name: 'Prepare print PDF' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('PDF unavailable')
  expect(screen.queryByRole('link', { name: 'Open / print PDF' })).not.toBeInTheDocument()
})
