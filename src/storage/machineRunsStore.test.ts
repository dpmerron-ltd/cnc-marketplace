import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportSnapshot } from '../machine/exportSnapshot'
const mock = vi.hoisted(() => ({ rpc: vi.fn(), getUser: vi.fn() }))
vi.mock('./supabaseClient', () => ({ supabase: { rpc: mock.rpc, auth: { getUser: mock.getUser } } }))
import { saveMachineRun } from './machineRunsStore'
const snapshot = { version: 1, files: [{ gcode: 'G21\nG90\nM30' }], map: { sheetCount: 10, parts: Array(86).fill({}) } } as ExportSnapshot
beforeEach(() => { vi.clearAllMocks(); mock.getUser.mockResolvedValue({ data: { user: { id: 'owner' } } }); mock.rpc.mockResolvedValue({ data: 'export-id', error: null }) })
describe('large immutable export saves', () => {
  it('sends the exact snapshot to the export RPC and confirms the saved ID', async () => {
    await saveMachineRun('export-id', 'owner', snapshot)
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('save_cnc_machine_run', { p_id: 'export-id', p_snapshot: snapshot })
  })
  it('keeps the same ID and programs when retrying a lost response', async () => {
    mock.rpc.mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } })
    await expect(saveMachineRun('export-id', 'owner', snapshot)).rejects.toThrow('connection lost')
    await saveMachineRun('export-id', 'owner', snapshot)
    expect(mock.rpc.mock.calls[0]).toEqual(mock.rpc.mock.calls[1])
  })
  it('blocks account changes before uploading and rejects unconfirmed saves', async () => {
    mock.getUser.mockResolvedValueOnce({ data: { user: { id: 'other' } } })
    await expect(saveMachineRun('export-id', 'owner', snapshot)).rejects.toThrow('account changed')
    expect(mock.rpc).not.toHaveBeenCalled()
    mock.rpc.mockResolvedValueOnce({ data: null, error: null })
    await expect(saveMachineRun('export-id', 'owner', snapshot)).rejects.toThrow('not saved')
  })
})
