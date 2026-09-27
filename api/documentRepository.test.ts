// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { documentRepository } from './documentRepository'
const row = { id: 'd', item_id: 'i', owner_id: 'alice', kind: 'packing' as const, filename: 'list.pdf', file_bytes: 3, pages: 1, file_path: 'alice/d/document.pdf', created_at: '' }
const input = { id: 'd', kind: 'packing' as const, filename: 'list.pdf', bytes: new Uint8Array([1, 2, 3]), pages: 1 }
const lookup = vi.fn(), insert = vi.fn(), single = vi.fn(), upload = vi.fn(), download = vi.fn()
const query = { select: () => query, eq: () => query, maybeSingle: lookup, insert, single }
const db = { from: () => query, storage: { from: () => ({ upload, download }) } } as unknown as SupabaseClient
beforeEach(() => { vi.resetAllMocks(); insert.mockReturnValue(query); lookup.mockResolvedValue({ data: null }); single.mockResolvedValue({ data: row }); upload.mockResolvedValue({ error: null }); download.mockResolvedValue({ data: new Blob([input.bytes]) }) })
it('uploads immutable bytes before publishing attributed metadata', async () => {
  expect(await documentRepository(db).uploadDocument('alice', 'i', input)).toEqual({ document: row, created: true })
  expect(upload).toHaveBeenCalledWith(row.file_path, input.bytes, { contentType: 'application/pdf', upsert: false })
  expect(insert).toHaveBeenCalledWith({ id: 'd', item_id: 'i', owner_id: 'alice', kind: 'packing', filename: 'list.pdf', file_bytes: 3, pages: 1 })
})
it('replays identical uploads but rejects changed bytes, metadata, parent or uploader', async () => {
  lookup.mockResolvedValue({ data: row })
  expect((await documentRepository(db).uploadDocument('alice', 'i', input)).created).toBe(false)
  for (const [owner, parent, change] of [['bob', 'i', {}], ['alice', 'other', {}], ['alice', 'i', { filename: 'new.pdf' }], ['alice', 'i', { bytes: new Uint8Array([3, 2, 1]) }]] as const) {
    await expect(documentRepository(db).uploadDocument(owner, parent, { ...input, ...change })).rejects.toMatchObject({ status: 409 })
  }
  expect(upload).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled()
})
it('resumes the same pending bytes after an interrupted upload', async () => {
  upload.mockResolvedValue({ error: { statusCode: '409' } })
  expect((await documentRepository(db).uploadDocument('alice', 'i', input)).created).toBe(true)
  download.mockResolvedValue({ data: new Blob(['bad']) })
  await expect(documentRepository(db).uploadDocument('alice', 'i', input)).rejects.toMatchObject({ status: 409 })
})
it('confirms a lost insert response without deleting any files', async () => {
  single.mockResolvedValue({ error: { message: 'timeout' } }); lookup.mockResolvedValueOnce({ data: null }).mockResolvedValueOnce({ data: row })
  expect((await documentRepository(db).uploadDocument('alice', 'i', input)).created).toBe(false)
})
it('requires the document to belong to the requested item', async () => {
  lookup.mockResolvedValue({ data: row })
  expect(await documentRepository(db).itemDocumentFile('bob', 'other', 'd')).toBeUndefined()
  expect(download).not.toHaveBeenCalled()
  expect((await documentRepository(db).itemDocumentFile('bob', 'i', 'd'))?.bytes).toEqual(input.bytes)
})
