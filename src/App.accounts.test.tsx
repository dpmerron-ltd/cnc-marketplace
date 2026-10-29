import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { testParts } from './test/jobFixtures'
import type { RemoteProjectState } from './storage/supabaseProjectStore'
import { defaultProgramSettings } from './gcode/programSettings'
import { summarizePart, type Part } from './models/Part'
import { loadProject } from './storage/projectStorage'
vi.mock('./ui/ItemDocuments', () => ({ ItemDocuments: () => <section aria-label="Item documents" /> }))
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

function cutSideLibrary() {
  const remote = library('alice')
  remote.parts = testParts.map(part => ({ ...part, ownerId: 'alice', itemId: 'alice-item' }))
  return { ...remote, sheet: {
    name: 'Cutting sides', width: 500, height: 500, spacing: 10, borderSpacing: 10,
    screwMarkingEnabled: false, gcodeSettings: { ...defaultProgramSettings, safeZ: 20 },
    instances: [{ id: 'first', partId: remote.parts[0].id, x: 20, y: 20, rotation: 0, locked: false, sheetIndex: 0, partNumber: 5 }],
  } }
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

function placedLibrary() {
  const remote = library('alice')
  remote.parts = testParts.map(part => ({ ...part, ownerId: 'alice', itemId: 'alice-item' }))
  return {
    ...remote,
    sheet: {
      name: 'Cutting job', orderNumber: 'ORDER-42', material: 'Plywood',
      width: 500, height: 500, spacing: 10, borderSpacing: 10, nextPartNumber: 12,
      screwMarkingEnabled: false,
      gcodeSettings: { ...defaultProgramSettings, safeZ: 20 },
      instances: [
        { id: 'first', partId: remote.parts[0].id, x: 20, y: 20, rotation: 0, locked: false, sheetIndex: 0, partNumber: 5 },
        { id: 'middle-locked', partId: remote.parts[1].id, x: 20, y: 20, rotation: 0, locked: true, sheetIndex: 1, partNumber: 7 },
        { id: 'middle', partId: remote.parts[0].id, x: 100, y: 20, rotation: 0, locked: false, sheetIndex: 1, partNumber: 8 },
        { id: 'last', partId: remote.parts[1].id, x: 20, y: 20, rotation: 0, locked: false, sheetIndex: 2, partNumber: 11 },
      ],
      orderImports: [
        { key: 'shared-order', name: 'ORDER-42', instanceIds: ['first', 'middle-locked'] },
        { key: 'middle-order', name: 'ORDER-43', instanceIds: ['middle'] },
        { key: 'last-order', name: 'ORDER-44', instanceIds: ['last'] },
      ],
    },
  }
}

describe('account switching', () => {
  beforeEach(() => { localStorage.clear(); mock.userId = 'alice'; mock.load.mockReset(); mock.loadItem.mockReset().mockResolvedValue([]); mock.save.mockClear(); mock.download.mockReset(); mock.programs.mockReset().mockResolvedValue(defaultProgramSettings); mock.savePrograms.mockReset().mockImplementation(async (_owner, value) => value) })
  afterEach(() => { cleanup(); window.history.replaceState({}, '', '/') })
  it('removes an empty job tab and returns to the other saved job', async () => {
    mock.load.mockResolvedValue(cutSideLibrary())
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    await openSheet()
    fireEvent.change(screen.getByRole('textbox', { name: 'Order number' }), { target: { value: 'KEEP' } })
    fireEvent.click(screen.getByRole('button', { name: 'New job' }))
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Remove job' }))
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: 'Order number' })).toHaveValue('KEEP')
    expect(confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(mock.save.mock.calls.at(-1)?.[5]).toMatchObject({ jobs: [expect.objectContaining({ sheet: expect.objectContaining({ orderNumber: 'KEEP' }) })] }))
    confirm.mockRestore()
  })
  it('confirms populated job removal from Cutting Jobs and saves it across reloads', async () => {
    mock.load.mockResolvedValue(cutSideLibrary())
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cutting Jobs' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove job' }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('1 waiting part'))
    expect(screen.getByRole('cell', { name: 'Sheet 1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove job' }))
    expect(screen.queryByRole('cell', { name: 'Sheet 1' })).not.toBeInTheDocument()
    await waitFor(() => expect(mock.save.mock.calls.at(-1)?.[5]).toMatchObject({ jobs: [expect.objectContaining({ sheet: expect.objectContaining({ instances: [] }) })] }))
    const saved = mock.save.mock.calls.at(-1)![5]
    cleanup()
    mock.load.mockResolvedValue({ ...cutSideLibrary(), workspace: saved })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cutting Jobs' }))
    expect(screen.queryByRole('cell', { name: 'Sheet 1' })).not.toBeInTheDocument()
    expect(screen.getByText(/No parts yet/)).toBeInTheDocument()
    confirm.mockRestore()
  })
  it('automatically saves independent material tabs and recalls their layouts', async () => {
    mock.load.mockResolvedValue(cutSideLibrary())
    render(<App />)
    await openSheet()
    fireEvent.change(screen.getByRole('combobox', { name: 'Sheet material thickness' }), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'New job' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Sheet material thickness' }), { target: { value: '18' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Order number' }), { target: { value: 'SECOND' } })
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    fireEvent.click(tabs[0])
    expect(screen.getByRole('combobox', { name: 'Sheet material thickness' })).toHaveValue('12')
    expect(screen.getByRole('textbox', { name: 'Order number' })).toHaveValue('')
    await waitFor(() => expect(mock.save.mock.calls.at(-1)?.[5]).toMatchObject({ jobs: [
      expect.objectContaining({ sheet: expect.objectContaining({ materialProfile: '12', instances: [expect.anything()] }) }),
      expect.objectContaining({ sheet: expect.objectContaining({ materialProfile: '18', orderNumber: 'SECOND', instances: [] }) }),
    ] }))
    const saved = mock.save.mock.calls.at(-1)![5]
    cleanup()
    mock.load.mockResolvedValue({ ...cutSideLibrary(), workspace: saved })
    render(<App />)
    await openSheet()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    fireEvent.click(screen.getAllByRole('tab')[1])
    expect(screen.getByRole('combobox', { name: 'Sheet material thickness' })).toHaveValue('18')
    expect(screen.getByRole('textbox', { name: 'Order number' })).toHaveValue('SECOND')
  })

  it('uses unloaded component metadata to choose a compatible sheet for manual additions', async () => {
    const { remote, components } = lazyLibrary()
    const faced = components.map((part, index): Part => ({ ...part, cutSide: index ? 'non-pattern' : 'pattern' }))
    remote.componentIndex = faced.map(summarizePart)
    remote.sheet = { ...cutSideLibrary().sheet, instances: [{ ...cutSideLibrary().sheet.instances[0], partId: faced[1].id }] }
    mock.load.mockResolvedValue(remote)
    mock.loadItem.mockImplementation(item => item.id === faced[0].itemId ? Promise.resolve([faced[0]]) : new Promise(() => {}))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: "Open alice's private item" }))
    await screen.findByRole('heading', { name: 'Panel 0' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to sheet' }))
    await waitFor(() => expect(mock.save.mock.calls.at(-1)?.[2]).toMatchObject({ instances: [
      expect.objectContaining({ partId: faced[1].id, sheetIndex: 0 }),
      expect.objectContaining({ partId: faced[0].id, sheetIndex: 1 }),
    ] }))
  })
  it('places individual components with opposite cutting faces on separate physical sheets', async () => {
    const remote = cutSideLibrary()
    remote.parts = remote.parts.map((part, index) => ({ ...part, cutSide: index ? 'non-pattern' : 'pattern' }))
    remote.sheet.instances = remote.sheet.instances.slice(0, 1)
    mock.load.mockResolvedValue(remote)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: "Open alice's private item" }))
    await screen.findByRole('heading', { name: remote.parts[1].name })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add to sheet' })[1])
    await openSheet()
    expect(await screen.findByRole('button', { name: 'Sheet 2' })).toHaveClass('active-sheet-tab')
    await waitFor(() => expect(mock.save.mock.calls.at(-1)?.[2]).toMatchObject({ instances: [
      expect.objectContaining({ partId: remote.parts[0].id, sheetIndex: 0 }),
      expect.objectContaining({ partId: remote.parts[1].id, sheetIndex: 1 }),
    ] }))
  })
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
      expect.anything(), 'bob', expect.anything(),
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

  it('loads a previous version on selection even when its components were not indexed at startup', async () => {
    const { remote, components } = lazyLibrary()
    remote.items[0].version = { familyId: 'rack', number: 1, status: 'published', isDefault: false }
    remote.items[1].version = { familyId: 'rack', number: 2, status: 'published', isDefault: true }
    remote.componentIndex = [summarizePart(components[1])]
    mock.load.mockResolvedValue(remote)
    mock.loadItem.mockImplementation(async item => components.filter(part => part.itemId === item.id))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open Second item' }))
    await screen.findByRole('heading', { name: 'Panel 1' })
    fireEvent.change(screen.getByLabelText('Item version'), { target: { value: remote.items[0].id } })
    expect(await screen.findByRole('heading', { name: 'Panel 0' })).toBeInTheDocument()
    expect(mock.loadItem).toHaveBeenCalledWith(remote.items[0], 'alice')
    expect(screen.queryByText('No components yet')).not.toBeInTheDocument()
  })

  it('preserves unloaded saved placements and history, blocks machining until loaded, and retries failures', async () => {
    const { remote, components } = lazyLibrary()
    remote.sheet = { name: 'Saved layout', width: 1220, height: 1220, spacing: 30, borderSpacing: 10, instances: [{ id: 'placed', partId: components[1].id, x: 40, y: 50, rotation: 0, locked: true, sheetIndex: 0 }], gcodeSettings: { startGcode: '', spindleStartGcode: '', endGcode: '', safeZ: 20 } }
    remote.sheetHistory = [{ id: 'saved', name: 'History layout', savedAt: '', sheet: remote.sheet, itemCount: 2, componentCount: 2, placedCount: 1 }]
    mock.load.mockResolvedValue(remote)
    mock.loadItem.mockRejectedValueOnce(new Error('Component fetch failed')).mockImplementation(async item => components.filter(part => part.itemId === item.id))
    render(<App />)
    await screen.findByRole('button', { name: 'Sheet' })
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.anything(), [], expect.objectContaining({ instances: [expect.objectContaining(remote.sheet!.instances[0])] }), expect.anything(), 'alice', expect.anything()))
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Order number' }), { target: { value: 'Updated order' } })
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.anything(), [], expect.objectContaining({ orderNumber: 'Updated order' }), expect.anything(), 'alice', expect.anything()))
  })

  it('confirms deleting all parts on the selected sheet, preserving other sheets and library components', async () => {
    const remote = placedLibrary()
    mock.load.mockResolvedValue(remote)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      const { container } = render(<App />)
      await openSheet()
      fireEvent.click(screen.getByRole('button', { name: 'Sheet 2' }))
      fireEvent.pointerDown(container.querySelector('.part-outline')!)
      expect(screen.getByRole('checkbox', { name: 'Locked' })).toBeChecked()
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
      expect(screen.getByRole('heading', { name: 'Combined G-code Preview' })).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Delete all parts from Sheet 2' }))
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Delete all 2 parts from Sheet 2?'))
      expect(container.querySelectorAll('.part-outline')).toHaveLength(2)
      expect(screen.getByRole('checkbox', { name: 'Locked' })).toBeChecked()
      expect(screen.getByRole('heading', { name: 'Combined G-code Preview' })).toBeInTheDocument()

      confirm.mockReturnValue(true)
      fireEvent.click(screen.getByRole('button', { name: 'Delete all parts from Sheet 2' }))
      expect(container.querySelectorAll('.part-outline')).toHaveLength(0)
      expect(screen.getByRole('button', { name: 'Delete all parts from Sheet 2' })).toBeDisabled()
      expect(screen.queryByRole('checkbox', { name: 'Locked' })).not.toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Combined G-code Preview' })).not.toBeInTheDocument()
      expect(container.querySelector('.with-simulator')).not.toBeInTheDocument()
      expect(screen.getByText('Deleted 2 parts from Sheet 2.')).toBeInTheDocument()

      const remaining = [remote.sheet.instances[0], remote.sheet.instances[3]]
      await waitFor(() => expect(mock.save.mock.calls.at(-1)?.[2]).toMatchObject({
        ...remote.sheet,
        instances: remaining,
        orderImports: [
          { ...remote.sheet.orderImports[0], instanceIds: ['first'] },
          remote.sheet.orderImports[2],
        ],
      }))
      expect(loadProject('alice')?.sheet.instances).toEqual(remaining)
      expect(loadProject('alice')?.parts).toHaveLength(2)
      fireEvent.click(screen.getByRole('button', { name: 'Sheet 1' }))
      expect(container.querySelectorAll('.part-outline')).toHaveLength(1)
      fireEvent.click(screen.getByRole('button', { name: 'Sheet 3' }))
      expect(container.querySelectorAll('.part-outline')).toHaveLength(1)
    } finally { confirm.mockRestore() }
  })

  it('keeps a valid selected sheet when deleting the last sheet and disables deletion on an empty job', async () => {
    mock.load.mockResolvedValue(placedLibrary())
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      const { container } = render(<App />)
      await openSheet()
      fireEvent.click(screen.getByRole('button', { name: 'Sheet 3' }))
      fireEvent.click(screen.getByRole('button', { name: 'Delete all parts from Sheet 3' }))
      expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('Delete all 1 part from Sheet 3?'))
      expect(screen.queryByRole('button', { name: 'Sheet 3' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Sheet 2' })).toHaveClass('active-sheet-tab')
      expect(container.querySelectorAll('.part-outline')).toHaveLength(2)
      fireEvent.click(screen.getByRole('button', { name: 'Delete all parts from Sheet 2' }))
      fireEvent.click(screen.getByRole('button', { name: 'Delete all parts from Sheet 1' }))
      expect(screen.getByRole('button', { name: 'Sheet 1' })).toHaveClass('active-sheet-tab')
      expect(screen.getByRole('button', { name: 'Delete all parts from Sheet 1' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Clear All Sheets' })).toBeDisabled()
      expect(container.querySelectorAll('.part-outline')).toHaveLength(0)
      await waitFor(() => expect(loadProject('alice')?.sheet.instances).toEqual([]))
    } finally { confirm.mockRestore() }
  })

  it('clears every sheet only after confirming the separate job-wide action', async () => {
    const remote = placedLibrary()
    mock.load.mockResolvedValue(remote)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      render(<App />)
      await openSheet()
      fireEvent.click(screen.getByRole('button', { name: 'Sheet 2' }))
      fireEvent.click(screen.getByRole('button', { name: 'Clear All Sheets' }))
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Delete all 4 parts from all sheets?'))
      expect(screen.getByRole('button', { name: 'Sheet 3' })).toBeInTheDocument()
      confirm.mockReturnValue(true)
      fireEvent.click(screen.getByRole('button', { name: 'Clear All Sheets' }))
      expect(screen.queryByRole('button', { name: 'Sheet 2' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Sheet 1' })).toHaveClass('active-sheet-tab')
      await waitFor(() => expect(mock.save.mock.calls.at(-1)?.[2]).toMatchObject({ ...remote.sheet, instances: [], orderImports: [] }))
      expect(loadProject('alice')?.parts).toHaveLength(2)
    } finally { confirm.mockRestore() }
  })

  it('can save sheet history to the cloud when the library exceeds browser backup capacity', async () => {
    const remote = library('alice')
    remote.parts = [{ ...testParts[0], ownerId: 'alice', itemId: 'alice-item', gcode: 'G01 X0 Y0\n'.repeat(220_000) }]
    mock.load.mockResolvedValue(remote)
    render(<App />)
    await openSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Save Sheet' }))
    await screen.findByText('Saved sheet to history.')
    expect(mock.save).toHaveBeenCalledWith(expect.anything(), [], expect.anything(), expect.anything(), 'alice', expect.anything())
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
    expect(screen.queryByRole('textbox', { name: 'Job name' })).not.toBeInTheDocument()
    expect(screen.getByRole('tablist', { name: 'Open cutting jobs' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Sheet item' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Manage items' }))
    expect(screen.getByRole('textbox', { name: 'Search items' })).toBeInTheDocument()
  })

  it('saves job, order and material details only to the active account', async () => {
    mock.load.mockResolvedValue(library('alice'))
    render(<App />)
    await openSheet()
    expect(screen.queryByRole('textbox', { name: 'Job name' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Order number' }), { target: { value: 'ORD-2048' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Material' }), { target: { value: '18 mm plywood' } })
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ orderNumber: 'ORD-2048', material: '18 mm plywood' }), expect.anything(), 'alice', expect.anything()))
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
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ safeZOverrideMm: 25, screwMarkingEnabled: true }), expect.anything(), 'alice', expect.anything()))
    mock.save.mockClear()
    fireEvent.click(override)
    fireEvent.click(marking)
    expect(height).toBeDisabled()
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ safeZOverrideMm: null, screwMarkingEnabled: false }), expect.anything(), 'alice', expect.anything()))
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
