import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { testParts } from './test/jobFixtures'
import type { RemoteProjectState } from './storage/supabaseProjectStore'
import { defaultProgramSettings } from './gcode/programSettings'
import { summarizePart, type Part } from './models/Part'
vi.mock('./storage/useBoxStock', () => ({ useBoxStock: () => ({ boxes: [], loading: false, reload: vi.fn() }) }))

const mock = vi.hoisted(() => ({
  userId: 'alice',
  authChanged: undefined as undefined | ((event: string, session: unknown) => void),
  load: vi.fn(), loadItem: vi.fn(), save: vi.fn<(...args: unknown[]) => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
  programs: vi.fn(), savePrograms: vi.fn(),
  download: vi.fn(),
}))
vi.mock('./storage/supabaseClient', () => ({
  supabaseUrl: 'https://test.supabase.co',
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: mock.userId, email: `${mock.userId}@example.com` } } } }),
      onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
        mock.authChanged = callback
        queueMicrotask(() => callback('INITIAL_SESSION', { user: { id: mock.userId, email: `${mock.userId}@example.com` } }))
        return { data: { subscription: { unsubscribe: () => { mock.authChanged = undefined } } } }
      },
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2' } }),
        listFactors: async () => ({ data: { totp: [] } }),
      },
    },
  },
}))
vi.mock('./storage/supabaseProjectStore', () => ({
  canUseSupabase: () => true,
  loadRemoteProject: (...args: unknown[]) => mock.load(...args),
  loadRemoteItemComponents: (...args: unknown[]) => mock.loadItem(...args),
  saveRemoteProject: (...args: unknown[]) => mock.save(...args),
  deleteRemoteComponent: vi.fn(), deleteRemoteSheetHistory: vi.fn(), saveRemoteSheetHistory: vi.fn(async () => ({ ok: true })),
  saveRemoteComponent: vi.fn(async () => ({ ok: true })),
}))
vi.mock('./storage/programSettingsStore', () => ({ loadProgramSettings: (...args: unknown[]) => mock.programs(...args), saveProgramSettings: (...args: unknown[]) => mock.savePrograms(...args) }))
vi.mock('./storage/projectStorage', async importOriginal => ({ ...await importOriginal<typeof import('./storage/projectStorage')>(), downloadText: (...args: unknown[]) => mock.download(...args) }))

function library(userId: string): RemoteProjectState {
  return {
    items: [{ id: `${userId}-item`, ownerId: userId, name: `${userId}'s private item`, sku: 'SKU', description: '', createdAt: '', updatedAt: '' }],
    parts: [], sheetHistory: [], gcodePresets: [],
  }
}

async function switchAccount(userId: string) {
  await act(async () => {
    mock.userId = userId
    mock.authChanged?.('SIGNED_IN', { user: { id: userId, email: `${userId}@example.com` } })
  })
}

function lazyLibrary() {
  const remote = library('alice')
  remote.items.push({ ...remote.items[0], id: 'alice-second', name: 'Second item', sku: 'SECOND' })
  const components = remote.items.map((item, index) => ({ ...testParts[0], id: `panel-${index}`, name: `Panel ${index}`, ownerId: 'alice', itemId: item.id }))
  remote.componentIndex = components.map(summarizePart)
  return { remote, components }
}

async function openSheet() {
  fireEvent.click(await screen.findByRole('button', { name: 'Sheet' }))
}

describe('account switching', () => {
  beforeEach(() => { localStorage.clear(); mock.userId = 'alice'; mock.load.mockReset(); mock.loadItem.mockReset().mockResolvedValue([]); mock.save.mockClear(); mock.download.mockReset(); mock.programs.mockReset().mockResolvedValue(defaultProgramSettings); mock.savePrograms.mockReset().mockImplementation(async (_owner, value) => value) })
  afterEach(cleanup)
  it('opens and edits a shared item and adds its components to another user’s sheet', async () => {
    mock.userId = 'bob'
    const { remote, components } = lazyLibrary()
    mock.load.mockResolvedValue(remote)
    mock.loadItem.mockImplementation(async item => components.filter(part => part.itemId === item.id))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: "Open alice's private item" }))
    await screen.findByRole('heading', { name: 'Panel 0' })
    expect(mock.loadItem).toHaveBeenCalledWith(remote.items[0], 'bob')
    fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Shared cabinet' } })
    expect(screen.getByLabelText('Item name')).toHaveValue('Shared cabinet')
    fireEvent.click(screen.getByRole('button', { name: 'Add all to sheet' }))
    await screen.findByText('1 components from Shared cabinet added to the sheet.')
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ ownerId: 'alice', name: 'Shared cabinet' })]),
      expect.anything(), expect.objectContaining({ instances: [expect.objectContaining({ partId: 'panel-0' })] }),
      expect.anything(), 'bob',
    ))
  })

  it('loads programs only for an opened item, shows progress and caches repeat opens', async () => {
    const { remote, components } = lazyLibrary()
    mock.load.mockResolvedValue(remote)
    let resolve!: (parts: Part[]) => void
    mock.loadItem.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    render(<App />)
    await screen.findByRole('button', { name: "Open alice's private item" })
    expect(mock.loadItem).not.toHaveBeenCalled()
    expect(screen.getByText(/^2 items/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: "Open alice's private item" }))
    await screen.findByText('Loading components...')
    expect(screen.queryByText('No components yet')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add all to sheet' })).toBeDisabled()
    expect(mock.loadItem).toHaveBeenCalledExactlyOnceWith(remote.items[0], 'alice')
    fireEvent.click(screen.getByRole('button', { name: 'All items' }))
    fireEvent.click(screen.getByRole('button', { name: "Open alice's private item" }))
    expect(mock.loadItem).toHaveBeenCalledTimes(1)
    await act(async () => resolve([components[0]]))
    expect(await screen.findByRole('heading', { name: 'Panel 0' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'All items' }))
    fireEvent.click(screen.getByRole('button', { name: "Open alice's private item" }))
    expect(mock.loadItem).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('heading', { name: 'Panel 1' })).not.toBeInTheDocument()
  })

  it('preserves unloaded saved placements and history, blocks machining until loaded, and retries failures', async () => {
    const { remote, components } = lazyLibrary()
    remote.sheet = { name: 'Saved layout', width: 1220, height: 1220, spacing: 30, borderSpacing: 10, instances: [{ id: 'placed', partId: components[1].id, x: 40, y: 50, rotation: 0, locked: true, sheetIndex: 0 }], gcodeSettings: { startGcode: '', spindleStartGcode: '', endGcode: '', safeZ: 20 } }
    remote.sheetHistory = [{ id: 'saved', name: 'History layout', savedAt: '', sheet: remote.sheet, itemCount: 2, componentCount: 2, placedCount: 1 }]
    mock.load.mockResolvedValue(remote)
    mock.loadItem.mockRejectedValueOnce(new Error('Component fetch failed')).mockImplementation(async item => components.filter(part => part.itemId === item.id))
    render(<App />)
    await screen.findByRole('button', { name: 'Sheet' })
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.anything(), [], expect.objectContaining({ instances: [expect.objectContaining(remote.sheet!.instances[0])] }), expect.anything(), 'alice'))
    expect(mock.loadItem).not.toHaveBeenCalled()
    await openSheet()
    expect(await screen.findByRole('alert')).toHaveTextContent('Component fetch failed')
    expect(screen.queryByRole('button', { name: 'Export Combined' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry sheet components' }))
    expect(await screen.findByRole('button', { name: 'Export Combined' })).toBeInTheDocument()
    await waitFor(() => expect(mock.save.mock.calls.at(-1)?.[2]).toMatchObject({ instances: [expect.objectContaining(remote.sheet!.instances[0])] }))
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    expect(await screen.findByText('History layout')).toBeInTheDocument()
    expect(mock.save.mock.calls.every(call => (call[1] as unknown[]).length === 0)).toBe(true)
  })

  it('does not accept a partial item response or treat it as an empty item', async () => {
    const { remote } = lazyLibrary()
    mock.load.mockResolvedValue(remote)
    mock.loadItem.mockResolvedValue([])
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: "Open alice's private item" }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Some components are no longer available')
    expect(screen.getByRole('button', { name: 'Add all to sheet' })).toBeDisabled()
    expect(screen.queryByText('No components yet')).not.toBeInTheDocument()
  })

  it('ignores an item download from an account that has been signed out', async () => {
    const { remote, components } = lazyLibrary()
    let resolve!: (parts: Part[]) => void
    mock.load.mockResolvedValueOnce(remote).mockResolvedValueOnce(library('bob'))
    mock.loadItem.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: "Open alice's private item" }))
    await screen.findByText('Loading components...')
    await switchAccount('bob')
    await screen.findByRole('button', { name: "Open bob's private item" })
    await act(async () => resolve(components))
    expect(screen.queryByText('Panel 0')).not.toBeInTheDocument()
    expect(screen.queryByText("alice's private item")).not.toBeInTheDocument()
    await waitFor(() => expect(mock.save.mock.calls.some(call => call[4] === 'bob')).toBe(true))
    expect(mock.save.mock.calls.filter(call => call[4] === 'bob').every(call => (call[1] as unknown[]).length === 0)).toBe(true)
  })

  it('loads the complete catalogue for explicit project export without changing source programs', async () => {
    const { remote, components } = lazyLibrary()
    mock.load.mockResolvedValue(remote)
    mock.loadItem.mockImplementation(async item => components.filter(part => part.itemId === item.id))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Export Project' }))
    await waitFor(() => expect(mock.download).toHaveBeenCalledTimes(1))
    const project = JSON.parse(mock.download.mock.calls[0][1])
    expect(project.parts).toHaveLength(2)
    expect(project.parts.map((part: Part) => part.gcode)).toEqual(components.map(part => part.gcode))
    expect(project.componentIndex).toBeUndefined()
    expect(mock.loadItem).toHaveBeenCalledTimes(2)
  })

  it('loads existing sheet obstacles before adding all components of another item', async () => {
    const { remote, components } = lazyLibrary()
    remote.sheet = { name: 'Existing parts', width: 1220, height: 1220, spacing: 30, borderSpacing: 10, instances: [{ id: 'obstacle', partId: components[1].id, x: 50, y: 50, rotation: 0, locked: true, sheetIndex: 0 }], gcodeSettings: { startGcode: '', spindleStartGcode: '', endGcode: '', safeZ: 20 } }
    mock.load.mockResolvedValue(remote)
    mock.loadItem.mockImplementation(async item => components.filter(part => part.itemId === item.id))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: "Open alice's private item" }))
    await screen.findByRole('heading', { name: 'Panel 0' })
    expect(mock.loadItem).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Add all to sheet' }))
    await screen.findByText("1 components from alice's private item added to the sheet.")
    expect(mock.loadItem).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(mock.save.mock.calls.at(-1)?.[2]).toMatchObject({ instances: expect.arrayContaining([expect.objectContaining(remote.sheet!.instances[0]), expect.objectContaining({ partId: components[0].id })]) }))
  })

  it('does not download an incomplete project when an unopened item fails', async () => {
    const { remote, components } = lazyLibrary()
    mock.load.mockResolvedValue(remote)
    mock.loadItem.mockResolvedValueOnce([components[0]]).mockRejectedValueOnce(new Error('Second item unavailable'))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Export Project' }))
    await screen.findByText('Project export failed: Second item unavailable')
    expect(mock.download).not.toHaveBeenCalled()
    mock.loadItem.mockResolvedValueOnce([components[1]])
    fireEvent.click(screen.getByRole('button', { name: 'Export Project' }))
    await waitFor(() => expect(mock.download).toHaveBeenCalledTimes(1))
    expect(JSON.parse(mock.download.mock.calls[0][1]).parts).toHaveLength(2)
    expect(mock.loadItem).toHaveBeenCalledTimes(3)
  })
  it('shows a retryable error without rendering or saving a false empty catalogue', async () => {
    mock.load.mockRejectedValueOnce(new Error('Could not load cutting components: timeout')).mockResolvedValueOnce(library('alice'))
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load cutting components: timeout')
    expect(screen.queryByRole('button', { name: 'New item' })).not.toBeInTheDocument()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    expect(mock.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading items' }))
    await screen.findByRole('button', { name: "Open alice's private item" })
    expect(mock.load).toHaveBeenCalledTimes(2)
  })

  it('saves sheet changes without resending already-persisted cutting programs', async () => {
    const remote = library('alice')
    remote.parts = [{ ...testParts[0], ownerId: 'alice', itemId: 'alice-item' }]
    mock.load.mockResolvedValue(remote)
    render(<App />)
    await openSheet()
    fireEvent.change(screen.getByRole('textbox', { name: 'Job name' }), { target: { value: 'Updated sheet' } })
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.anything(), [], expect.objectContaining({ name: 'Updated sheet' }), expect.anything(), 'alice'))
  })

  it('can save sheet history to the cloud when the library exceeds browser backup capacity', async () => {
    const remote = library('alice')
    remote.parts = [{ ...testParts[0], ownerId: 'alice', itemId: 'alice-item', gcode: 'G01 X0 Y0\n'.repeat(220_000) }]
    mock.load.mockResolvedValue(remote)
    render(<App />)
    await openSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Save Sheet' }))
    await screen.findByText('Saved sheet to history.')
    expect(mock.save).toHaveBeenCalledWith(expect.anything(), [], expect.anything(), expect.anything(), 'alice')
  })

  it('keeps programs private across account switches and requires setup for new accounts', async () => {
    mock.load.mockImplementation(async owner => library(owner))
    mock.programs.mockImplementation(async owner => owner === 'alice' ? { ...defaultProgramSettings, startGcode: '(Alice only)\nG21 G90' } : undefined)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Profile' }))
    await waitFor(() => expect(screen.getByLabelText('Start program')).toHaveValue('(Alice only)\nG21 G90'))
    await switchAccount('bob')
    fireEvent.click(await screen.findByRole('button', { name: 'Profile' }))
    await waitFor(() => expect(screen.getByLabelText('Start program')).toHaveValue(''))
    expect(screen.queryByText('Alice only')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(await screen.findByText('CNC program setup required')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'User Profile' }))
    fireEvent.change(screen.getByLabelText('Start program'), { target: { value: 'G21 G90\n(Bob only)' } })
    fireEvent.change(screen.getByLabelText('Spindle start'), { target: { value: 'S16000 M03' } })
    fireEvent.change(screen.getByLabelText('End program'), { target: { value: 'M05\nM30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    await screen.findByText('Settings saved')
    expect(mock.savePrograms).toHaveBeenCalledWith('bob', { startGcode: 'G21 G90\n(Bob only)', spindleStartGcode: 'S16000 M03', endGcode: 'M05\nM30' })
  })

  it('keeps sheet controls off the dedicated items page', async () => {
    mock.load.mockResolvedValue(library('alice'))
    render(<App />)
    await screen.findByRole('button', { name: "Open alice's private item" })
    expect(screen.getByRole('textbox', { name: 'Search items' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Job name' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Auto Nest' })).not.toBeInTheDocument()
    await openSheet()
    expect(screen.getByRole('textbox', { name: 'Job name' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Sheet item' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Manage items' }))
    expect(screen.getByRole('textbox', { name: 'Search items' })).toBeInTheDocument()
  })

  it('saves job, order and material details only to the active account', async () => {
    mock.load.mockResolvedValue(library('alice'))
    render(<App />)
    await openSheet()
    const name = await screen.findByRole('textbox', { name: 'Job name' })
    fireEvent.change(name, { target: { value: 'Camperlocker' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Order number' }), { target: { value: 'ORD-2048' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Material' }), { target: { value: '18 mm plywood' } })
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ name: 'Camperlocker', orderNumber: 'ORD-2048', material: '18 mm plywood' }), expect.anything(), 'alice'))
    mock.load.mockResolvedValue(library('bob'))
    await switchAccount('bob')
    await screen.findByText("bob's private item")
    await openSheet()
    expect(screen.getByRole('textbox', { name: 'Order number' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Material' })).toHaveValue('')
  })

  it('defaults to screw marking with a 30 mm gap and 10 mm border, and persists explicit opt-outs', async () => {
    mock.load.mockResolvedValue(library('alice'))
    render(<App />)
    await openSheet()
    const marking = await screen.findByRole('checkbox', { name: 'Screw marks' })
    const override = screen.getByRole('checkbox', { name: 'Override safe Z' })
    const height = screen.getByRole('spinbutton', { name: 'Safe Z (mm)' })
    expect(marking).toBeChecked()
    expect(screen.getByRole('spinbutton', { name: 'Gap' })).toHaveValue(30)
    expect(screen.getByRole('spinbutton', { name: 'Border' })).toHaveValue(10)
    expect(override).toBeChecked()
    expect(height).toBeEnabled()
    expect(height).toHaveValue(20)
    fireEvent.change(height, { target: { value: '25' } })
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ safeZOverrideMm: 25, screwMarkingEnabled: true }), expect.anything(), 'alice'))
    mock.save.mockClear()
    fireEvent.click(override)
    fireEvent.click(marking)
    expect(height).toBeDisabled()
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ safeZOverrideMm: null, screwMarkingEnabled: false }), expect.anything(), 'alice'))
    fireEvent.click(override)
    expect(height).toHaveValue(20)
  })

  it.each([undefined, false, true])('restores screw marking %s and preserves saved spacing', async (screwMarkingEnabled) => {
    const remote = library('alice')
    remote.sheet = {
      name: 'Saved', width: 500, height: 500, spacing: 5, borderSpacing: 20, instances: [],
      screwMarkingEnabled,
      gcodeSettings: { startGcode: 'G21\nG90', spindleStartGcode: 'S18000\nM03', endGcode: 'M05\nM30', safeZ: 5 },
    }
    mock.load.mockResolvedValue(JSON.parse(JSON.stringify(remote)))
    render(<App />)
    await openSheet()
    const marking = await screen.findByRole('checkbox', { name: 'Screw marks' })
    if (screwMarkingEnabled === false) expect(marking).not.toBeChecked()
    else expect(marking).toBeChecked()
    expect(screen.getByRole('spinbutton', { name: 'Gap' })).toHaveValue(5)
    expect(screen.getByRole('spinbutton', { name: 'Border' })).toHaveValue(20)
  })

  it.each([undefined, null, 35])('restores saved override %s without losing an explicit off choice', async (safeZOverrideMm) => {
    const remote = library('alice')
    remote.sheet = {
      name: 'Saved', width: 500, height: 500, spacing: 10, borderSpacing: 10, instances: [],
      safeZOverrideMm,
      gcodeSettings: { startGcode: 'G21\nG90', spindleStartGcode: 'S18000\nM03', endGcode: 'M05\nM30', safeZ: 5 },
    }
    mock.load.mockResolvedValue(JSON.parse(JSON.stringify(remote)))
    render(<App />)
    await openSheet()
    const override = await screen.findByRole('checkbox', { name: 'Override safe Z' })
    const height = screen.getByRole('spinbutton', { name: 'Safe Z (mm)' })
    expect(height).toHaveValue(safeZOverrideMm ?? 20)
    if (safeZOverrideMm === null) {
      expect(override).not.toBeChecked()
      expect(height).toBeDisabled()
    } else {
      expect(override).toBeChecked()
      expect(height).toBeEnabled()
    }
  })

  it('clears a previous library when the next account is empty and only saves the new account snapshot', async () => {
    mock.load.mockResolvedValueOnce(library('alice')).mockResolvedValueOnce({ items: [], parts: [], sheetHistory: [], gcodePresets: [] })
    render(<App />)
    await screen.findByText("alice's private item")
    await switchAccount('bob')
    await waitFor(() => expect(mock.load).toHaveBeenCalledWith('bob', expect.any(Function)))
    await screen.findByRole('button', { name: 'New item' })
    expect(screen.queryByText("alice's private item")).not.toBeInTheDocument()
    await waitFor(() => expect(mock.save).toHaveBeenCalled(), { timeout: 1500 })
    const bobSaves = mock.save.mock.calls.filter((args) => args[4] === 'bob')
    expect(bobSaves.length).toBeGreaterThan(0)
    expect(bobSaves.every((args) => (args[0] as unknown[]).length === 0)).toBe(true)
  })

  it('ignores a previous account load that finishes after switching accounts', async () => {
    let resolveAlice!: (value: RemoteProjectState) => void
    mock.load.mockImplementationOnce(() => new Promise((resolve) => { resolveAlice = resolve })).mockResolvedValueOnce(library('bob'))
    render(<App />)
    await waitFor(() => expect(mock.load).toHaveBeenCalledWith('alice', expect.any(Function)))
    await switchAccount('bob')
    await screen.findByText("bob's private item")
    await act(async () => resolveAlice(library('alice')))
    expect(screen.queryByText("alice's private item")).not.toBeInTheDocument()
    expect(screen.getByText("bob's private item")).toBeInTheDocument()
  })
})
