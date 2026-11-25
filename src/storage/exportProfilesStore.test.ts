import { beforeEach, expect, it, vi } from 'vitest'
import { loadExportProfiles } from './exportProfilesStore'
const mock = vi.hoisted(() => ({ user: vi.fn(), rpc: vi.fn() }))
vi.mock('./supabaseClient', () => ({ supabase: { auth: { getUser: mock.user }, rpc: mock.rpc } }))
const row = (machine_key: string, is_current = false) => ({ machine_key, is_current, start_gcode: 'G21\nG17\nG90\nG94', spindle_start_gcode: '', end_gcode: 'M05\nM30' })
beforeEach(() => { mock.user.mockReset().mockResolvedValue({ data: { user: { id: 'dan' } } }); mock.rpc.mockReset() })
it('loads current saved programs only on request, preserving manual spindle settings', async () => {
  mock.rpc.mockResolvedValue({ data: [row('andy'), row('dan', true)] })
  const profiles = await loadExportProfiles('dan')
  expect(mock.rpc).toHaveBeenCalledWith('load_cnc_export_profiles')
  expect(profiles.map(p => p.label)).toEqual(['Andy', 'Dan'])
  expect(profiles[0].programs.spindleStartGcode).toBe('')
})
it('preserves single-account behavior for accounts outside this machine pair', async () => {
  mock.rpc.mockResolvedValue({ data: [] }); expect(await loadExportProfiles('dan')).toEqual([])
})
it('rejects an account change before querying shared programs', async () => {
  await expect(loadExportProfiles('other')).rejects.toThrow('account changed')
  expect(mock.rpc).not.toHaveBeenCalled()
})
it.each([[row('dan', true)], [row('dan', true), row('dan')], [row('andy'), row('dan')]])('rejects incomplete or ambiguous profiles', async (...data) => {
  mock.rpc.mockResolvedValue({ data }); await expect(loadExportProfiles('dan')).rejects.toThrow('Both Andy and Dan')
})
it('propagates API failure instead of exporting a partial pair', async () => {
  mock.rpc.mockResolvedValue({ error: { message: 'Unavailable' } })
  await expect(loadExportProfiles('dan')).rejects.toThrow('Unavailable')
})
