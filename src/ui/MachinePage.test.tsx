import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MachinePage } from './MachinePage'
import { ncHash, type MachineRun } from '../machine/exportSnapshot'

const mock = vi.hoisted(() => ({ list: vi.fn(), load: vi.fn(), change: vi.fn(), download: vi.fn() }))
vi.mock('../storage/machineRunsStore', () => ({ listMachineRuns: (...args: unknown[]) => mock.list(...args), loadMachineRun: (...args: unknown[]) => mock.load(...args), changeMachineRunStatus: (...args: unknown[]) => mock.change(...args) }))
vi.mock('../storage/projectStorage', () => ({ downloadText: (...args: unknown[]) => mock.download(...args) }))
const id = '00000000-0000-4000-8000-000000000001'
const makeRun = async (): Promise<MachineRun> => ({
  id, owner_id: 'alice', name: 'Rack', order_number: '1007', material: 'Ply', thickness: '12 mm', sheet_count: 2, part_count: 2, status: 'waiting', created_at: '2026-09-23T12:00:00Z',
  snapshot: { version: 1, mode: 'sheets', material: 'Ply', thickness: '12 mm', safeZ: 20, deepestCutMm: 12.2, warnings: [], programs: { startGcode: 'G21', spindleStartGcode: '', endGcode: 'M30', safeZ: 20 },
    files: await Promise.all(['one.nc', 'two.nc'].map(async filename => ({ filename, gcode: filename, sha256: await ncHash(filename), estimatedSeconds: 120 }))),
    sheets: [0, 1].map(index => ({ index, maxX: 100, maxY: 100, screws: [] })),
    map: { name: 'Rack', order: '1007', width: 1220, height: 1220, sheetCount: 2, parts: [0, 1].map(index => ({ number: `P00${index + 1}`, name: `Side ${index + 1}`, sheetIndex: index, rotation: 0, bounds: { minX: 10, minY: 10, maxX: 100, maxY: 100 }, paths: [[{ x: 10, y: 10 }, { x: 100, y: 100 }]], warnings: [], tabs: [{ points: [{ x: 20, y: 10 }, { x: 30, y: 10 }], center: { x: 25, y: 10 }, z: -6.2, inferred: false, operation: 'Outer' }] })) },
  },
})
describe('At Machine', () => {
  beforeEach(async () => { window.history.replaceState({}, '', '#machine'); mock.list.mockReset().mockResolvedValue([await makeRun()]); mock.load.mockReset().mockResolvedValue(await makeRun()); mock.change.mockReset().mockResolvedValue(undefined); mock.download.mockReset() })
  afterEach(() => { cleanup(); window.history.replaceState({}, '', '/') })
  it('loads summaries only, then the selected export; switches physical sheets and downloads the unchanged file', async () => {
    render(<MachinePage userId="alice" />)
    fireEvent.click(await screen.findByRole('button', { name: /Rack/ }))
    await screen.findByRole('heading', { name: 'Rack' })
    expect(mock.list).toHaveBeenCalledWith('alice', 0, 'waiting', expect.any(AbortSignal))
    expect(mock.load).toHaveBeenCalledTimes(1)
    expect(screen.getByText('12.2 mm')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Sheet 1 cutting paths and tab locations' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'P001 Side 1 1 tabs' }))
    expect(screen.getByRole('columnheader', { name: 'Z' })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Physical sheet' }), { target: { value: '1' } })
    expect(screen.getByText('two.nc')).toBeInTheDocument()
    expect(screen.queryByText('one.nc')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'P001 Side 1 1 tabs' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Download NC' }))
    await waitFor(() => expect(mock.download).toHaveBeenCalledWith('two.nc', 'two.nc', 'application/x-gcode'))
    expect(mock.change).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Mark cutting' }))
    await screen.findByRole('button', { name: 'Mark completed' })
    expect(mock.change).toHaveBeenCalledWith('alice', expect.objectContaining({ status: 'waiting' }), 'cutting')
  })
  it('opens a direct phone link, refuses a corrupted saved download, and retains the current status on conflict', async () => {
    window.history.replaceState({}, '', `#machine/${id}`)
    const run = await makeRun(); run.snapshot.files[0].gcode = 'modified'
    mock.load.mockResolvedValue(run)
    mock.change.mockRejectedValue(new Error('Changed on another device'))
    render(<MachinePage userId="alice" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Download NC' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('integrity check failed')
    expect(mock.download).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Mark cutting' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Changed on another device')
    expect(screen.getByRole('button', { name: 'Mark cutting' })).toBeEnabled()
    expect(mock.list).not.toHaveBeenCalled()
  })
  it('does not reveal a previous account response after switching accounts', async () => {
    window.history.replaceState({}, '', `#machine/${id}`)
    let resolve!: (run: MachineRun) => void
    mock.load.mockReturnValueOnce(new Promise<MachineRun>(done => { resolve = done })).mockRejectedValueOnce(new Error('Not found'))
    const view = render(<MachinePage userId="alice" />)
    view.rerender(<MachinePage userId="bob" />)
    await screen.findByRole('alert')
    await act(async () => resolve(await makeRun()))
    expect(screen.queryByRole('heading', { name: 'Rack' })).not.toBeInTheDocument()
  })
})
