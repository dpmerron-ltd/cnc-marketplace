import { beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import type { ExportSnapshot } from '../machine/exportSnapshot'
const mock = vi.hoisted(() => ({ rpc: vi.fn(), getUser: vi.fn() }))
vi.mock('./supabaseClient', () => ({ supabase: { rpc: mock.rpc, auth: { getUser: mock.getUser } } }))
import { saveMachineRun } from './machineRunsStore'
const snapshot = { version: 1, files: [{ gcode: 'G21\nG90\nM30' }], map: { sheetCount: 10, parts: Array(86).fill({}) } } as ExportSnapshot
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.clearAllMocks(); mock.getUser.mockResolvedValue({ data: { user: { id: 'owner' } } }); mock.rpc.mockResolvedValue({ data: 'export-id', error: null }) })
describe('large immutable export saves', () => {
  it('uploads bounded chunks that reconstruct the exact snapshot, then verifies its hash', async () => {
    const large = { material: 'x'.repeat(1024 * 1024 - 14) + '🪵', version: snapshot.version, map: snapshot.map, files: [{ gcode: 'G21\n'.repeat(500000) }] } as ExportSnapshot
    await saveMachineRun('export-id', 'owner', large)
    const uploads = mock.rpc.mock.calls.filter(([name]) => name === 'upload_cnc_machine_run_chunk')
    expect(uploads.length).toBeGreaterThan(2)
    const reconstructed = uploads.map(([, args]) => args.p_content).join('')
    expect(reconstructed).toBe(JSON.stringify(large))
    expect(uploads.every(([, args]) => new TextDecoder().decode(new TextEncoder().encode(args.p_content)) === args.p_content)).toBe(true)
    expect(uploads.every(([, args], index) => args.p_content.length <= 1024 * 1024 && args.p_index === index && args.p_count === uploads.length)).toBe(true)
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(reconstructed))
    expect(mock.rpc.mock.lastCall).toEqual(['finish_cnc_machine_run_upload', { p_id: 'export-id', p_count: uploads.length, p_hash: Buffer.from(digest).toString('hex') }])
  })
  it('does not finalize a failed upload and retries identical chunks and ID', async () => {
    mock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } })
    await expect(saveMachineRun('export-id', 'owner', snapshot)).rejects.toThrow('connection lost')
    expect(mock.rpc).toHaveBeenCalledTimes(1)
    await saveMachineRun('export-id', 'owner', snapshot)
    expect(mock.rpc.mock.calls[0]).toEqual(mock.rpc.mock.calls[1])
  })
  it('blocks account changes and unconfirmed saves', async () => {
    mock.getUser.mockResolvedValueOnce({ data: { user: { id: 'other' } } })
    await expect(saveMachineRun('export-id', 'owner', snapshot)).rejects.toThrow('account changed')
    expect(mock.rpc).not.toHaveBeenCalled()
    mock.rpc.mockResolvedValueOnce({ data: null, error: null })
    await expect(saveMachineRun('export-id', 'owner', snapshot)).rejects.toThrow('not saved')
  })
})
