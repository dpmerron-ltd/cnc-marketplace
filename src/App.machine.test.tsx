import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { testItem, testParts } from './test/jobFixtures'
import { defaultProgramSettings } from './gcode/programSettings'

const mock = vi.hoisted(() => ({ saveRun: vi.fn(), download: vi.fn(), load: vi.fn(), loadRun: vi.fn(), recuts: vi.fn(), completeRecuts: vi.fn() }))
vi.mock('./storage/exportNamesStore', () => ({ reserveExportName: vi.fn(async () => '2026-10-29-001') }))
vi.mock('./storage/machineRecutsStore', () => ({ listMachineRecuts: (...args: unknown[]) => mock.recuts(...args), listRunRecuts: async () => [], queueMachineRecut: vi.fn(), changeMachineRecutStatus: vi.fn(), completeSheetRecuts: (...args: unknown[]) => mock.completeRecuts(...args) }))
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
    mock.recuts.mockReset().mockResolvedValue([]); mock.completeRecuts.mockReset().mockResolvedValue(undefined)
    mock.saveRun.mockReset().mockResolvedValue(undefined); mock.download.mockReset()
    mock.load.mockResolvedValue({ items: [{ ...testItem, ownerId: 'alice' }], parts: testParts.map(part => ({ ...part, ownerId: 'alice' })), sheetHistory: [], gcodePresets: [], sheet: {
      name: 'Machine snapshot', width: 1220, height: 1220, spacing: 30, borderSpacing: 10, screwMarkingEnabled: false, safeZOverrideMm: 20,
      gcodeSettings: { ...defaultProgramSettings, safeZ: 20 }, instances: [{ id: 'copy', partId: testParts[0].id, sheetIndex: 0, x: 10, y: 10, rotation: 0, locked: false }],
    } })
  })
  afterEach(cleanup)
  it('keeps V1 as the default and offers V2 with its retained-waste spacing', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet' }))
    const method = await screen.findByRole('combobox', { name: 'Nesting method' })
    expect(method).toHaveValue('v1')
    fireEvent.change(method, { target: { value: 'v2' } })
    expect(method).toHaveValue('v2')
    expect(await screen.findByText('V2 shared-edge nesting')).toBeInTheDocument()
    expect(screen.getByText(/the border is 13 mm/)).toBeInTheDocument()
    fireEvent.change(method, { target: { value: 'v1' } })
    expect(method).toHaveValue('v1')
    expect(screen.queryByText('V2 shared-edge nesting')).not.toBeInTheDocument()
  })

  it('lets an existing V2 sheet recover from the old 22 mm minimum without moving parts', async () => {
    const remote = await mock.load()
    remote.sheet = { ...remote.sheet, nestingMethod: 'v2', borderSpacing: 22 }
    mock.load.mockResolvedValue(remote)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use 13 mm V2 border' }))
    expect(screen.getByRole('spinbutton', { name: 'Border' })).toHaveValue(13)
    expect(screen.getByText(/Click Auto Nest to rebuild the layout/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use 13 mm V2 border' })).not.toBeInTheDocument()
    expect(screen.getByText(/Shaped or notched outlines retain separate cuts/)).toBeInTheDocument()
  })

  it('lets the operator override pattern faces for the sheet and restores the restriction when unticked', async () => {
    const remote = await mock.load()
    remote.parts = remote.parts.map((part: typeof testParts[number], i: number) => ({ ...part, cutSide: i ? 'non-pattern' : 'pattern' }))
    remote.sheet.instances.push({ ...remote.sheet.instances[0], id: 'second', partId: testParts[1].id, x: 150 })
    mock.load.mockResolvedValue(remote)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet' }))
    const toggle = await screen.findByRole('checkbox', { name: 'Ignore pattern sides' })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    expect(toggle).toBeChecked()
    fireEvent.click(await screen.findByRole('button', { name: 'Export Combined' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Export G-code' }))
    await waitFor(() => expect(mock.download).toHaveBeenCalledTimes(1))
    expect(mock.download.mock.calls[0][1]).toContain('(Load material: Either side)')
    expect(mock.saveRun.mock.calls[0][2].sheets[0].cutSide).toBe('either')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ignore pattern sides' }))
    expect(screen.getByRole('checkbox', { name: 'Ignore pattern sides' })).not.toBeChecked()
    expect(screen.getAllByText(/mixes pattern-side-up and non-pattern-side-up/).length).toBeGreaterThan(0)
  })

  it('preserves a machine link through sign-in and does not require the catalogue to load', async () => {
    const id = '00000000-0000-4000-8000-000000000001'
    window.history.replaceState({}, '', `#machine/${id}`)
    mock.load.mockReturnValue(new Promise(() => {}))
    mock.loadRun.mockRejectedValue(new Error('Export not found'))
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Export not found')
    expect(mock.loadRun).toHaveBeenCalledWith('alice', id, expect.any(AbortSignal))
    expect(screen.getByRole('heading', { name: 'Previous exports' })).toBeInTheDocument()
  })
  it('blocks download on cloud failure, retries the same ID, and saves exact NC bytes', async () => {
    mock.saveRun.mockRejectedValueOnce(new Error('Offline'))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Export Combined' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Export G-code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Offline')
    expect(mock.download).not.toHaveBeenCalled()
    const savedId = mock.saveRun.mock.calls[0][0]
    fireEvent.click(await screen.findByRole('button', { name: 'Export G-code' }))
    await waitFor(() => expect(mock.download).toHaveBeenCalledTimes(1))
    expect(mock.saveRun.mock.calls[1][0]).toBe(savedId)
    expect(mock.saveRun.mock.calls[1][1]).toBe('alice')
    expect(mock.saveRun.mock.calls[1][2].files[0].gcode).toBe(mock.download.mock.calls[0][1])
    expect(mock.saveRun.mock.calls[1][2].map.parts[0].number).toBe('P001')
    await screen.findByText(/saved to Cutting Jobs, waiting to cut/)
  })
  it('uses a new revision for waiting sheets and excludes sheets already marked cut', async () => {
    const remote = await mock.load()
    remote.parts = remote.parts.map((part: typeof testParts[number], i: number) => ({ ...part, cutSide: i ? 'non-pattern' : 'pattern' }))
    remote.sheet.instances.push({ ...remote.sheet.instances[0], id: 'second', partId: testParts[1].id, sheetIndex: 1 })
    mock.load.mockResolvedValue(remote)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Export Sheets' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Export G-code' }))
    await waitFor(() => expect(mock.download).toHaveBeenCalledTimes(2))
    expect(mock.download.mock.calls.map(call => call[0])).toEqual(['2026-10-29-001-sheet-1-pattern-side-up.nc', '2026-10-29-001-sheet-2-non-pattern-side-up.nc'])
    fireEvent.click(screen.getByRole('button', { name: 'Cutting Jobs' }))
    fireEvent.click((await screen.findAllByRole('button', { name: 'Mark cut' }))[0])
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Mark cut' })).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open job' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Open job' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export Sheets' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Export G-code' }))
    await waitFor(() => expect(mock.download).toHaveBeenCalledTimes(3))
    expect(mock.download.mock.calls[2][0]).toBe('2026-10-29-001-r2-sheet-2-non-pattern-side-up.nc')
    expect(mock.saveRun.mock.calls[1][2].map.parts).toHaveLength(1)
    expect(mock.saveRun.mock.calls[1][2].map.parts[0].sheetIndex).toBe(1)
    expect(mock.saveRun.mock.calls[1][2].labels).toHaveLength(1)
  })

  it('places the exact queued replacement once and completes it when its new sheet is cut', async () => {
    const remote = await mock.load()
    remote.sheet.material = 'Ply'
    mock.load.mockResolvedValue(remote)
    const entry = { id: 'replacement', owner_id: 'alice', source_run_id: 'original-export', sheet_index: 0, part_number: 'P001', part_name: testParts[0].name, job_name: 'Original job', order_number: 'ORDER-77', material: 'Ply', thickness: 'Original NC', status: 'queued', created_at: '2026-10-29T09:00:00Z' }
    mock.recuts.mockResolvedValue([entry])
    mock.loadRun.mockResolvedValue({ snapshot: { material: 'Ply', thickness: 'Original NC', map: { parts: [{ partId: testParts[0].id, itemId: testItem.id, sheetIndex: 0, number: 'P001' }] } } })
    window.history.replaceState({}, '', '#queue/recuts')
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add to sheet' }))
    await screen.findByText('Added replacement P001 to Sheet 1. Review and export the updated layout.')
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }))
    expect(await screen.findByRole('button', { name: 'Added to job' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Sheet' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export Sheets' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Export G-code' }))
    await waitFor(() => expect(mock.download).toHaveBeenCalledTimes(1))
    const snapshot = mock.saveRun.mock.calls[0][2]
    expect(snapshot.map.parts.map((part: { partId: string }) => part.partId)).toEqual([testParts[0].id, testParts[0].id])
    expect(snapshot.labels[1].order).toBe('ORDER-77')
    fireEvent.click(screen.getByRole('button', { name: 'Cutting Jobs' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Mark cut' }))
    await waitFor(() => expect(mock.completeRecuts).toHaveBeenCalledWith('alice', ['replacement']))
  })

  it('ignores double confirmation while the cloud save is pending', async () => {
    let resolve!: () => void
    mock.saveRun.mockImplementation(() => new Promise<void>(done => { resolve = done }))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sheet' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Export Sheets' }))
    const confirm = await screen.findByRole('button', { name: 'Export G-code' })
    fireEvent.click(confirm); fireEvent.click(confirm)
    await waitFor(() => expect(mock.saveRun).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Saving export...' })).toBeDisabled()
    expect(mock.download).not.toHaveBeenCalled()
    await act(async () => resolve())
    await waitFor(() => expect(mock.download).toHaveBeenCalledTimes(1))
  })
})
