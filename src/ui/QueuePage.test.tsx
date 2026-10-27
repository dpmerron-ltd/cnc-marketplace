import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuePage } from './QueuePage'
import type { MachineRecut } from '../machine/recuts'

const mock = vi.hoisted(() => ({ list: vi.fn(), change: vi.fn(), jobs: vi.fn() }))
vi.mock('../storage/machineRecutsStore', () => ({ listMachineRecuts: (...args: unknown[]) => mock.list(...args), changeMachineRecutStatus: (...args: unknown[]) => mock.change(...args) }))
vi.mock('../storage/jobsApi', () => ({ jobApiRequest: (...args: unknown[]) => mock.jobs(...args), jobsApiUrl: '', downloadJobFile: vi.fn() }))
vi.mock('../storage/supabaseClient', () => ({ supabase: null }))
const entry: MachineRecut = {
  id: 'recut-1', owner_id: 'alice', source_run_id: '00000000-0000-4000-8000-000000000001',
  sheet_index: 1, part_number: 'P002', part_name: 'Shelf', job_name: 'Rack', order_number: '1007',
  material: 'Ply', thickness: '12 mm', status: 'queued', created_at: '2026-10-27T12:00:00Z', updated_at: '2026-10-27T12:00:00Z',
}

describe('re-cut queue', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '#queue/recuts')
    mock.list.mockReset().mockResolvedValue([entry])
    mock.change.mockReset().mockResolvedValue(undefined)
    mock.jobs.mockReset().mockResolvedValue({ json: async () => ({ jobs: [] }) })
  })
  afterEach(() => { cleanup(); window.history.replaceState({}, '', '/') })

  it('opens from At Machine without loading API jobs and marks a pending part as re-cut', async () => {
    render(<QueuePage userId="alice" />)
    const source = await screen.findByRole('link', { name: 'P002 · Shelf' })
    expect(source).toHaveAttribute('href', `#machine/${entry.source_run_id}?sheet=2&part=P002`)
    expect(screen.getByText('Sheet 2')).toBeInTheDocument()
    expect(screen.getByText('Order 1007')).toBeInTheDocument()
    expect(screen.getByText('Ply')).toBeInTheDocument()
    expect(screen.getByText('12 mm')).toBeInTheDocument()
    expect(mock.list).toHaveBeenCalledWith('alice', 0, 'queued', expect.any(AbortSignal))
    expect(mock.jobs).not.toHaveBeenCalled()
    mock.list.mockResolvedValue([])
    fireEvent.click(screen.getByRole('button', { name: 'Mark re-cut' }))
    expect(await screen.findByText('P002 marked as re-cut.')).toBeInTheDocument()
    expect(await screen.findByText('No parts waiting to be re-cut.')).toBeInTheDocument()
    expect(mock.change).toHaveBeenCalledExactlyOnceWith('alice', entry, 'completed')
  })

  it('retains the pending part after a save failure and lets the operator remove it on retry', async () => {
    mock.change.mockRejectedValueOnce(new Error('Changed on another device'))
    render(<QueuePage userId="alice" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Changed on another device')
    expect(screen.getByRole('link', { name: 'P002 · Shelf' })).toBeInTheDocument()
    mock.list.mockResolvedValue([])
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('P002 removed from the re-cut queue.')).toBeInTheDocument()
    expect(mock.change).toHaveBeenLastCalledWith('alice', entry, 'cancelled')
  })

  it('refreshes saved re-cuts, shows history, and keeps the existing jobs tab available', async () => {
    window.history.replaceState({}, '', '#queue')
    render(<QueuePage userId="alice" />)
    await screen.findByText('No jobs in this queue.')
    fireEvent.click(screen.getByRole('button', { name: 'Re-cuts' }))
    await screen.findByRole('link', { name: 'P002 · Shelf' })
    mock.list.mockResolvedValue([{ ...entry, status: 'completed' }])
    fireEvent.change(screen.getByRole('combobox', { name: 'Re-cut status' }), { target: { value: 'completed' } })
    await waitFor(() => expect(mock.list).toHaveBeenLastCalledWith('alice', 0, 'completed', expect.any(AbortSignal)))
    await screen.findByRole('link', { name: 'P002 · Shelf' })
    expect(screen.queryByRole('button', { name: 'Mark re-cut' })).not.toBeInTheDocument()
    const previous = mock.list.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Refresh queue' }))
    await waitFor(() => expect(mock.list.mock.calls.length).toBeGreaterThan(previous))
    fireEvent.click(screen.getByRole('button', { name: 'Jobs' }))
    expect(await screen.findByText('No jobs in this queue.')).toBeInTheDocument()
  })

  it('ignores an earlier account response and shows load errors without claiming the queue is empty', async () => {
    let finish!: (entries: MachineRecut[]) => void
    mock.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockRejectedValueOnce(new Error('Queue unavailable'))
    const view = render(<QueuePage userId="alice" />)
    view.rerender(<QueuePage userId="bob" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Queue unavailable')
    await act(async () => finish([entry]))
    expect(screen.queryByRole('link', { name: 'P002 · Shelf' })).not.toBeInTheDocument()
    expect(screen.queryByText('No parts waiting to be re-cut.')).not.toBeInTheDocument()
  })
})
