import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { RemoteProjectState } from './storage/supabaseProjectStore'

const mock = vi.hoisted(() => ({
  userId: 'alice',
  authChanged: undefined as undefined | ((event: string, session: unknown) => void),
  load: vi.fn(), save: vi.fn<(...args: unknown[]) => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
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
  saveRemoteProject: (...args: unknown[]) => mock.save(...args),
  deleteRemoteComponent: vi.fn(), deleteRemoteSheetHistory: vi.fn(), saveRemoteSheetHistory: vi.fn(),
}))

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

describe('account switching', () => {
  beforeEach(() => { localStorage.clear(); mock.userId = 'alice'; mock.load.mockReset(); mock.save.mockClear() })
  afterEach(cleanup)

  it('saves job, order and material details only to the active account', async () => {
    mock.load.mockResolvedValue(library('alice'))
    render(<App />)
    const name = await screen.findByRole('textbox', { name: 'Job name' })
    fireEvent.change(name, { target: { value: 'Camperlocker' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Order number' }), { target: { value: 'ORD-2048' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Material' }), { target: { value: '18 mm plywood' } })
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ name: 'Camperlocker', orderNumber: 'ORD-2048', material: '18 mm plywood' }), expect.anything(), 'alice'))
    mock.load.mockResolvedValue(library('bob'))
    await switchAccount('bob')
    await screen.findByText("bob's private item")
    expect(screen.getByRole('textbox', { name: 'Order number' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Material' })).toHaveValue('')
  })

  it('defaults to screw marking with a 30 mm gap and 10 mm border, and persists explicit opt-outs', async () => {
    mock.load.mockResolvedValue(library('alice'))
    render(<App />)
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
    await waitFor(() => expect(mock.load).toHaveBeenCalledWith('bob'))
    await screen.findByRole('button', { name: 'New Item' })
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
    await waitFor(() => expect(mock.load).toHaveBeenCalledWith('alice'))
    await switchAccount('bob')
    await screen.findByText("bob's private item")
    await act(async () => resolveAlice(library('alice')))
    expect(screen.queryByText("alice's private item")).not.toBeInTheDocument()
    expect(screen.getByText("bob's private item")).toBeInTheDocument()
  })
})
