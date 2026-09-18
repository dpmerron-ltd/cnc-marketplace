import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultProgramSettings } from '../gcode/programSettings'
import { loadProgramSettings, saveProgramSettings } from './programSettingsStore'

const mock = vi.hoisted(() => ({ owner: 'alice', row: null as unknown, error: null as { message: string } | null, calls: [] as Array<{ table: string; owner?: string; write?: unknown }> }))
vi.mock('./supabaseClient', () => ({ supabase: {
  auth: { getUser: async () => ({ data: { user: { id: mock.owner } } }) },
  from: (table: string) => {
    const call: { table: string; owner?: string; write?: unknown } = { table }; mock.calls.push(call)
    const builder = {
      select: () => builder,
      eq: (_field: string, owner: string) => { call.owner = owner; return builder },
      upsert: (row: unknown) => { call.write = row; return builder },
      maybeSingle: async () => ({ data: mock.row, error: mock.error }),
      single: async () => ({ data: { owner_id: mock.owner }, error: mock.error }),
    }
    return builder
  },
} }))

describe('private profile storage', () => {
  beforeEach(() => { mock.owner = 'alice'; mock.row = null; mock.error = null; mock.calls = [] })
  it('does not give an unconfigured account another user\'s defaults', async () => {
    expect(await loadProgramSettings('alice')).toBeUndefined()
    expect(mock.calls).toEqual([{ table: 'user_program_settings', owner: 'alice' }])
  })
  it('saves only the authenticated owner and rejects session switches', async () => {
    expect(await saveProgramSettings('alice', defaultProgramSettings)).toEqual(defaultProgramSettings)
    expect(mock.calls[0].write).toMatchObject({ owner_id: 'alice', start_gcode: defaultProgramSettings.startGcode })
    mock.calls = []; mock.owner = 'bob'
    await expect(loadProgramSettings('alice')).rejects.toThrow('account changed')
    await expect(saveProgramSettings('alice', defaultProgramSettings)).rejects.toThrow('account changed')
    expect(mock.calls).toEqual([])
  })
  it('round-trips a controller macro verbatim within the authenticated account', async () => {
    const programs = { ...defaultProgramSettings, startGcode: 'M98 P"0:/macros/Probe"\nM400\nM291 P"Remove probe" R"Warning" S3' }
    expect(await saveProgramSettings('alice', programs)).toEqual(programs)
    mock.row = mock.calls[0].write
    expect(mock.row).toMatchObject({ owner_id: 'alice', start_gcode: programs.startGcode })
    expect(await loadProgramSettings('alice')).toEqual(programs)
  })
  it('fails closed on read/write errors, mismatched ownership and invalid programs', async () => {
    mock.error = { message: 'Offline' }
    await expect(loadProgramSettings('alice')).rejects.toThrow('Offline')
    await expect(saveProgramSettings('alice', defaultProgramSettings)).rejects.toThrow('Offline')
    mock.error = null; mock.row = { owner_id: 'bob' }
    await expect(loadProgramSettings('alice')).rejects.toThrow('another account')
    mock.calls = []
    await expect(saveProgramSettings('alice', { ...defaultProgramSettings, startGcode: 'M30' })).rejects.toThrow()
    expect(mock.calls).toEqual([])
  })
})
