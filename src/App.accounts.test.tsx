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

  it('makes screw marking opt-in and persists the optional safe Z height', async () => {
    mock.load.mockResolvedValue(library('alice'))
    render(<App />)
    const marking = await screen.findByRole('checkbox', { name: 'Screw marks' })
    const override = screen.getByRole('checkbox', { name: 'Override safe Z' })
    const height = screen.getByRole('spinbutton', { name: 'Safe Z (mm)' })
    expect(marking).not.toBeChecked()
    expect(override).not.toBeChecked()
    expect(height).toBeDisabled()
    fireEvent.click(override)
    expect(height).toBeEnabled()
    fireEvent.change(height, { target: { value: '20' } })
    fireEvent.click(marking)
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ safeZOverrideMm: 20, screwMarkingEnabled: true }), expect.anything(), 'alice'))
    mock.save.mockClear()
    fireEvent.click(override)
    fireEvent.click(marking)
    expect(height).toBeDisabled()
    await waitFor(() => expect(mock.save).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ safeZOverrideMm: undefined, screwMarkingEnabled: false }), expect.anything(), 'alice'))
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
