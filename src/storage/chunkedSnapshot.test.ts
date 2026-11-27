import { beforeEach, expect, it, vi } from 'vitest'
import { webcrypto, createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hydrateExportSnapshot } from './chunkedSnapshot'
const snapshot = { version: 1, files: [{ filename: 'test.nc', gcode: 'G21\nG90\n🪵' }], map: { parts: [{ number: '1', paths: [[{ x: 1.5, y: 2 }]] }] } }
const payload = JSON.stringify(snapshot)
const chunks = [payload.slice(0, 20), payload.slice(20)]
const manifest = { version: 1, storage: 'chunks-v1', chunkCount: 2, sha256: createHash('sha256').update(payload).digest('hex') }
function client(rows = chunks.map((content, chunk_index) => ({ content, chunk_index }))) {
  const query = { select: vi.fn(), eq: vi.fn(), gte: vi.fn(), lt: vi.fn(), order: vi.fn(), abortSignal: vi.fn(), then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve) }
  for (const key of ['select', 'eq', 'gte', 'lt', 'order', 'abortSignal'] as const) query[key].mockReturnValue(query)
  return { db: { from: vi.fn().mockReturnValue(query) } as unknown as SupabaseClient, query }
}
beforeEach(() => vi.stubGlobal('crypto', webcrypto))
it('reconstructs the exact files and geometry and scopes each read to the owner and export', async () => {
  const { db, query } = client()
  expect(await hydrateExportSnapshot(db, 'owner', 'run', manifest)).toEqual(snapshot)
  expect(query.eq).toHaveBeenCalledWith('owner_id', 'owner')
  expect(query.eq).toHaveBeenCalledWith('export_id', 'run')
})
it('rejects altered or missing chunks before returning any cutting programs', async () => {
  await expect(hydrateExportSnapshot(client([{ chunk_index: 0, content: 'changed' }, { chunk_index: 1, content: chunks[1] }]).db, 'owner', 'run', manifest)).rejects.toThrow('checksum mismatch')
  await expect(hydrateExportSnapshot(client([]).db, 'owner', 'run', manifest)).rejects.toThrow('incomplete')
})
it('keeps legacy saved exports readable without chunk requests', async () => {
  const { db } = client()
  expect(await hydrateExportSnapshot(db, 'owner', 'run', snapshot)).toEqual(snapshot)
  expect(db.from).not.toHaveBeenCalled()
})
