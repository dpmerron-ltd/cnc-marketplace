import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { testItem, testParts } from './test/jobFixtures'
import { defaultProgramSettings } from './gcode/programSettings'

const mock = vi.hoisted(() => ({ saveRun: vi.fn(), download: vi.fn(), load: vi.fn(), loadRun: vi.fn() }))
vi.mock('./storage/useBoxStock', () => ({ useBoxStock: () => ({ boxes: [], loading: false, reload: vi.fn() }) }))
vi.mock('./storage/machineRunsStore', () => ({ saveMachineRun: (...args: unknown[]) => mock.saveRun(...args), loadMachineRun: (...args: unknown[]) => mock.loadRun(...args) }))
vi.mock('./storage/supabaseClient', () => ({ supabaseUrl: 'https://test.supabase.co', supabase: { auth: {
  getSession: async () => ({ data: { session: { user: { id: 'alice', email: 'alice@example.com' } } } }),
  onAuthStateChange: (callback: (event: string, session: unknown) => void) => { queueMicrotask(() => callback('INITIAL_SESSION', { user: { id: 'alice', email: 'alice@example.com' } })); return { data: { subscription: { unsubscribe() {} } } } },
  mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2' } }), listFactors: async () => ({ data: { totp: [] } }) },
} } }))
vi.mock('./storage/supabaseProjectStore', () => ({ canUseSupabase: () => true, loadRemoteProject: (...args: unknown[]) => mock.load(...args), loadRemoteItemComponents: vi.fn(async () => []), saveRemoteProject: vi.fn(async () => ({ ok: true })), saveRemoteSheetHistory: vi.fn(async () => ({ ok: true })), deleteRemoteComponent: vi.fn(), deleteRemoteItem: vi.fn(), deleteRemoteSheetHistory: vi.fn(), saveRemoteComponent: vi.fn() }))
vi.mock('./storage/programSettingsStore', () => ({ loadProgramSettings: async () => defaultProgramSettings, saveProgramSettings: vi.fn() }))
vi.mock('./storage/projectStorage', async original => ({ ...await original<typeof import('./storage/projectStorage')>(), downloadText: (...args: unknown[]) => mock.download(...args) }))

describe('export saves a machine snapshot before downloading', () => {
  beforeEach(() => {
    localStorage.clear(); window.history.replaceState({}, '', '/')
    mock.saveRun.mockReset().mockResolvedValue(undefined); mock.download.mockReset()
    mock.load.mockResolvedValue({ items: [{ ...testItem, ownerId: 'alice' }], parts: testParts.map(part => ({ ...part, ownerId: 'alice' })), sheetHistory: [], gcodePresets: [], sheet: {
      name: 'Machine snapshot', width: 1220, height: 1220, spacing: 30, borderSpacing: 10, screwMarkingEnabled: false, safeZOverrideMm: 20,
      gcodeSettings: { ...defaultProgramSettings, safeZ: 20 }, instances: [{ id: 'copy', partId: testParts[0].id, sheetIndex: 0, x: 10, y: 10, rotation: 0, locked: false }],
    } })
  })
  afterEach(cleanup)
  it('preserves a machine link through sign-in and does not require the catalogue to load', async () => {
    const id = '00000000-0000-4000-8000-000000000001'
    window.history.replaceState({}, '', `#machine/${id}`)
    mock.load.mockReturnValue(new Promise(() => {}))
    mock.loadRun.mockRejectedValue(new Error('Export not found'))
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Export not found')
    expect(mock.loadRun).toHaveBeenCalledWith('alice', id, expect.any(AbortSignal))
    expect(screen.getByRole('heading', { name: 'At Machine' })).toBeInTheDocument()
  })
  it('blocks download on cloud failure, retries the same ID, and saves exact NC bytes', async () => {
    mock.saveRun.mockRejectedValueOnce(new Error('Offline'))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Export Combined' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export G-code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Offline')
    expect(mock.download).not.toHaveBeenCalled()
    const savedId = mock.saveRun.mock.calls[0][0]
    fireEvent.click(screen.getByRole('button', { name: 'Export G-code' }))
    await waitFor(() => expect(mock.download).toHaveBeenCalledTimes(1))
    expect(mock.saveRun.mock.calls[1][0]).toBe(savedId)
    expect(mock.saveRun.mock.calls[1][1]).toBe('alice')
    expect(mock.saveRun.mock.calls[1][2].files[0].gcode).toBe(mock.download.mock.calls[0][1])
    expect(mock.saveRun.mock.calls[1][2].map.parts[0].number).toBe('P001')
    await screen.findByText(/saved to At Machine, waiting to cut/)
  })
  it('ignores double confirmation while the cloud save is pending', async () => {
    let resolve!: () => void
    mock.saveRun.mockImplementation(() => new Promise<void>(done => { resolve = done }))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Export Sheets' }))
    const confirm = screen.getByRole('button', { name: 'Export G-code' })
    fireEvent.click(confirm); fireEvent.click(confirm)
    await waitFor(() => expect(mock.saveRun).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Saving export...' })).toBeDisabled()
    expect(mock.download).not.toHaveBeenCalled()
    await act(async () => resolve())
    await waitFor(() => expect(mock.download).toHaveBeenCalledTimes(1))
  })
})
