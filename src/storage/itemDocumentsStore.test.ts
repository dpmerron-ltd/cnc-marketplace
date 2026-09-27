import { beforeEach, expect, it, vi } from 'vitest'
import { downloadItemDocument, listItemDocuments, removeItemDocument, uploadItemDocument } from './itemDocumentsStore'
import type { ItemDocument } from '../documents/itemDocuments'
const mock = vi.hoisted(() => ({ user: vi.fn(), upload: vi.fn(), remove: vi.fn(), download: vi.fn(), insert: vi.fn(), single: vi.fn(), maybe: vi.fn(), abort: vi.fn(), eq: vi.fn(), range: vi.fn(), save: vi.fn(), inspect: vi.fn() }))
vi.mock('../documents/itemDocuments', async original => ({ ...await original<typeof import('../documents/itemDocuments')>(), inspectPdf: mock.inspect }))
vi.mock('./supabaseProjectStore', () => ({ saveCatalogueItem: mock.save }))
vi.mock('./supabaseClient', () => {
  const query = { select: () => query, order: () => query, range: (...args: unknown[]) => { mock.range(...args); return query }, eq: (...args: unknown[]) => { mock.eq(...args); return query }, abortSignal: mock.abort, insert: mock.insert, delete: () => query, single: mock.single, maybeSingle: mock.maybe }
  return { supabase: { auth: { getUser: mock.user }, from: () => query, storage: { from: () => ({ upload: mock.upload, remove: mock.remove, download: mock.download }) } } }
})
const owner = 'alice'
const item = { id: 'item', ownerId: owner, name: 'Rack', sku: 'VS-3', description: '', createdAt: '', updatedAt: '' }
const doc: ItemDocument = { id: 'd', item_id: item.id, owner_id: owner, kind: 'instructions', filename: 'manual.pdf', pages: 2, file_bytes: 4, file_path: 'alice/d/document.pdf', created_at: '' }
beforeEach(() => {
  vi.resetAllMocks()
  mock.user.mockResolvedValue({ data: { user: { id: owner } } }); mock.save.mockResolvedValue({ ok: true }); mock.inspect.mockResolvedValue(2)
  mock.upload.mockResolvedValue({ error: null }); mock.remove.mockResolvedValue({ error: null }); mock.insert.mockResolvedValue({ error: null }); mock.maybe.mockResolvedValue({ data: null })
  mock.single.mockResolvedValue({ data: { id: 'd' } }); mock.abort.mockResolvedValue({ data: [doc] }); mock.download.mockResolvedValue({ data: new Blob(['data']) })
})
it('saves the item, uploads immutable PDF bytes with the right MIME, then publishes metadata', async () => {
  await uploadItemDocument(owner, item, 'instructions', new File(['data'], 'manual.pdf'))
  expect(mock.save).toHaveBeenCalledWith(item, owner)
  expect(mock.upload).toHaveBeenCalledWith(expect.stringMatching(/^alice\/.+\/document.pdf$/), expect.objectContaining({ type: 'application/pdf', size: 4 }), { contentType: 'application/pdf', upsert: false })
  expect(mock.insert).toHaveBeenCalledWith(expect.objectContaining({ item_id: item.id, kind: 'instructions', pages: 2 }))
  expect(mock.save.mock.invocationCallOrder[0]).toBeLessThan(mock.upload.mock.invocationCallOrder[0])
  expect(mock.upload.mock.invocationCallOrder[0]).toBeLessThan(mock.insert.mock.invocationCallOrder[0])
})
it('does not delete files if an insert succeeded but its response was lost', async () => {
  mock.insert.mockImplementation(async (row: { id: string }) => { mock.maybe.mockResolvedValue({ data: { id: row.id } }); return { error: { message: 'Lost response' } } })
  await uploadItemDocument(owner, item, 'packing', new File(['data'], 'packing.pdf'))
  expect(mock.remove).not.toHaveBeenCalled()
})
it('cleans failed uploads only after confirming no published metadata exists', async () => {
  mock.insert.mockResolvedValue({ error: { message: 'Failed' } })
  await expect(uploadItemDocument(owner, item, 'packing', new File(['data'], 'packing.pdf'))).rejects.toThrow('Failed')
  expect(mock.remove).toHaveBeenCalledTimes(1)
  mock.remove.mockClear(); mock.maybe.mockResolvedValue({ error: { message: 'Offline' } })
  await expect(uploadItemDocument(owner, item, 'packing', new File(['data'], 'packing.pdf'))).rejects.toThrow('retained')
  expect(mock.remove).not.toHaveBeenCalled()
})
it('reads only the selected item metadata and supports pagination', async () => {
  mock.abort.mockResolvedValueOnce({ data: Array.from({ length: 100 }, () => doc) }).mockResolvedValueOnce({ data: [] })
  expect(await listItemDocuments(owner, item.id, new AbortController().signal)).toHaveLength(100)
  expect(mock.eq).toHaveBeenCalledWith('item_id', item.id)
  expect(mock.range).toHaveBeenLastCalledWith(100, 199)
  expect(mock.download).not.toHaveBeenCalled()
})
it('allows shared downloads but only uploader deletion; rejects account changes and damaged bytes', async () => {
  mock.user.mockResolvedValue({ data: { user: { id: 'bob' } } })
  expect((await downloadItemDocument('bob', doc)).type).toBe('application/pdf')
  await expect(removeItemDocument('bob', doc)).rejects.toThrow('Only the uploader')
  await expect(downloadItemDocument(owner, doc)).rejects.toThrow('account changed')
  mock.download.mockResolvedValue({ data: new Blob(['truncated']) })
  await expect(downloadItemDocument('bob', doc)).rejects.toThrow('does not match')
})
