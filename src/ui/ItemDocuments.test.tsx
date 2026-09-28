import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ItemDocuments } from './ItemDocuments'
import type { ItemDocument } from '../documents/itemDocuments'
import { testItem } from '../test/jobFixtures'

const mock = vi.hoisted(() => ({ list: vi.fn(), download: vi.fn() }))
vi.mock('../storage/itemDocumentsStore', () => ({ listItemDocuments: mock.list, downloadItemDocument: mock.download, removeItemDocument: vi.fn(), uploadItemDocument: vi.fn() }))

it('hides documents and opened PDFs from the previous selection while another version loads', async () => {
  const document = { id: 'pdf', item_id: testItem.id, owner_id: 'alice', kind: 'packing', filename: 'previous.pdf', file_bytes: 10, pages: 1, file_path: 'original.pdf', created_at: '' } satisfies ItemDocument
  let finish!: (rows: ItemDocument[]) => void
  mock.list.mockResolvedValueOnce([document]).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  mock.download.mockResolvedValue(new Blob(['PDF']))
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: vi.fn() })
  try {
    const view = render(<ItemDocuments userId="alice" item={testItem} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open previous.pdf' }))
    await screen.findByRole('link', { name: 'Open / print PDF' })
    view.rerender(<ItemDocuments userId="alice" item={{ ...testItem, id: 'other-version' }} readOnly />)
    expect(screen.queryByText('previous.pdf')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open / print PDF' })).not.toBeInTheDocument()
    expect(screen.getByText('Loading documents...')).toBeInTheDocument()
    await act(async () => finish([]))
    expect(screen.getAllByText('No PDF uploaded.')).toHaveLength(2)
    view.unmount()
  } finally { vi.unstubAllGlobals() }
})
