import { beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadPrintable, listPrintables, removePrintable, uploadPrintable } from './printablesStore'
import type { PrintableAsset } from '../printing/types'
const mock = vi.hoisted(() => ({ user: vi.fn(), upload: vi.fn(), remove: vi.fn(), download: vi.fn(), insert: vi.fn(), single: vi.fn(), maybe: vi.fn(), abort: vi.fn(), from: vi.fn(), eq: vi.fn(), range: vi.fn() }))
vi.mock('./supabaseClient', () => {
  const query = { select: () => query, order: () => query, range: (...args: unknown[]) => { mock.range(...args); return query }, eq: (...args: unknown[]) => { mock.eq(...args); return query }, ilike: () => query, abortSignal: mock.abort, insert: mock.insert, delete: () => query, single: mock.single, maybeSingle: mock.maybe }
  return { supabase: { auth: { getUser: mock.user }, from: (...args: unknown[]) => { mock.from(...args); return query }, storage: { from: () => ({ upload: mock.upload, remove: mock.remove, download: mock.download }) } } }
})
const owner = '10000000-0000-4000-8000-000000000001', id = '20000000-0000-4000-8000-000000000001'
const details = { name: 'Corner', purpose: 'packaging' as const, item_id: null, notes: 'PETG', units: 'mm' as const }
const asset: PrintableAsset = { ...details, id, owner_id: owner, filename: 'corner.stl', file_bytes: 4, triangles: 12, dimensions: [20, 30, 40], created_at: '', stl_path: `${owner}/${id}/model.stl`, preview_path: `${owner}/${id}/preview.png` }
const file = () => new File(['mesh'], 'corner.stl'), preview = () => new Blob(['image'], { type: 'image/png' })
beforeEach(() => {
  vi.clearAllMocks()
  mock.user.mockResolvedValue({ data: { user: { id: owner } }, error: null })
  mock.upload.mockResolvedValue({ error: null }); mock.remove.mockResolvedValue({ error: null }); mock.insert.mockResolvedValue({ error: null }); mock.maybe.mockResolvedValue({ data: null, error: null })
  mock.single.mockResolvedValue({ data: { id }, error: null }); mock.abort.mockResolvedValue({ data: [asset], count: 1, error: null })
  mock.download.mockResolvedValue({ data: new Blob(['mesh']), error: null })
})
describe('Shared print storage', () => {
  it('uploads the original STL and PNG before publishing metadata without overwriting files', async () => {
    const source = file()
    await uploadPrintable(owner, id, details, source, preview(), asset)
    expect(mock.upload).toHaveBeenNthCalledWith(1, asset.stl_path, expect.objectContaining({ size: source.size, type: 'model/stl' }), { contentType: 'model/stl', upsert: false })
    expect(mock.upload).toHaveBeenNthCalledWith(2, asset.preview_path, expect.any(Blob), { contentType: 'image/png', upsert: false })
    expect(mock.insert).toHaveBeenCalledWith(expect.objectContaining({ id, owner_id: owner, purpose: 'packaging', triangles: 12 }))
    expect(mock.remove).not.toHaveBeenCalled()
  })
  it('cleans up a partial failed upload but never deletes a confirmed published upload', async () => {
    mock.upload.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'Preview failed' } })
    await expect(uploadPrintable(owner, id, details, file(), preview(), asset)).rejects.toThrow('Preview failed')
    expect(mock.insert).not.toHaveBeenCalled(); expect(mock.remove).toHaveBeenCalledWith([asset.stl_path, asset.preview_path])
    mock.remove.mockClear(); mock.upload.mockResolvedValue({ error: null }); mock.insert.mockResolvedValue({ error: { message: 'Lost response' } }); mock.maybe.mockResolvedValue({ data: { id }, error: null })
    await uploadPrintable(owner, id, details, file(), preview(), asset)
    expect(mock.remove).not.toHaveBeenCalled()
  })
  it('does not clean up files when insert confirmation is uncertain', async () => {
    mock.insert.mockResolvedValue({ error: { message: 'offline' } }); mock.maybe.mockResolvedValue({ data: null, error: { message: 'offline' } })
    await expect(uploadPrintable(owner, id, details, file(), preview(), asset)).rejects.toThrow('Refresh the library')
    expect(mock.remove).not.toHaveBeenCalled()
  })
  it('allows a different signed-in user to download the original STL, but not remove it', async () => {
    mock.user.mockResolvedValue({ data: { user: { id: 'bob' } } })
    expect((await downloadPrintable('bob', asset)).size).toBe(4)
    await expect(removePrintable('bob', asset)).rejects.toThrow('Only the uploader')
    expect(mock.remove).not.toHaveBeenCalled()
  })
  it('fails closed on account changes or a truncated download', async () => {
    await expect(downloadPrintable('bob', asset)).rejects.toThrow('account changed')
    expect(mock.download).not.toHaveBeenCalled()
    mock.download.mockResolvedValue({ data: new Blob(['bad']), error: null })
    await expect(downloadPrintable(owner, asset)).rejects.toThrow('does not match')
  })
  it('loads paginated shared metadata, not every binary or only the uploader files', async () => {
    await listPrintables(owner, { search: '', purpose: '', item: '', page: 1 }, new AbortController().signal)
    expect(mock.range).toHaveBeenCalledWith(24, 47)
    expect(mock.eq).not.toHaveBeenCalledWith('owner_id', expect.anything())
    expect(mock.download).not.toHaveBeenCalled()
  })
  it('removes metadata before cleaning up uploader-owned objects', async () => {
    await removePrintable(owner, asset)
    expect(mock.eq).toHaveBeenCalledWith('owner_id', owner)
    expect(mock.single.mock.invocationCallOrder[0]).toBeLessThan(mock.remove.mock.invocationCallOrder[0])
  })
})
