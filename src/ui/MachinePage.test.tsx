import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MachinePage } from './MachinePage'
import { newProductionJob } from '../jobs/production'
import { ncHash, type MachineRun } from '../machine/exportSnapshot'
import type { MachineRecut } from '../machine/recuts'

const mock = vi.hoisted(() => ({ list: vi.fn(), load: vi.fn(), change: vi.fn(), download: vi.fn(), recuts: vi.fn(), queueRecut: vi.fn() }))
vi.mock('../storage/machineRunsStore', () => ({ listMachineRuns: (...args: unknown[]) => mock.list(...args), loadMachineRun: (...args: unknown[]) => mock.load(...args), changeMachineRunStatus: (...args: unknown[]) => mock.change(...args) }))
vi.mock('../storage/machineRecutsStore', () => ({ listRunRecuts: (...args: unknown[]) => mock.recuts(...args), queueMachineRecut: (...args: unknown[]) => mock.queueRecut(...args) }))
vi.mock('../storage/projectStorage', () => ({ downloadText: (...args: unknown[]) => mock.download(...args) }))
const id = '00000000-0000-4000-8000-000000000001'
const makeRecut = (sheetIndex = 0, partNumber = 'P001'): MachineRecut => ({ id: 'recut-1', owner_id: 'alice', source_run_id: id, sheet_index: sheetIndex, part_number: partNumber, part_name: `Side ${sheetIndex + 1}`, job_name: 'Rack', order_number: '1007', material: 'Ply', thickness: '12 mm', status: 'queued', created_at: '2026-10-27T12:00:00Z', updated_at: '2026-10-27T12:00:00Z' })
const makeRun = async (): Promise<MachineRun> => ({
  id, owner_id: 'alice', name: 'Rack', order_number: '1007', material: 'Ply', thickness: '12 mm', sheet_count: 2, part_count: 2, status: 'waiting', created_at: '2026-09-23T12:00:00Z',
  snapshot: { version: 1, mode: 'sheets', material: 'Ply', thickness: '12 mm', safeZ: 20, deepestCutMm: 12.2, warnings: [], programs: { startGcode: 'G21', spindleStartGcode: '', endGcode: 'M30', safeZ: 20 },
    files: await Promise.all(['one.nc', 'two.nc'].map(async filename => ({ filename, gcode: filename, sha256: await ncHash(filename), estimatedSeconds: 120 }))),
    sheets: [0, 1].map(index => ({ index, maxX: 100, maxY: 100, screws: [] })),
    map: { name: 'Rack', order: '1007', width: 1220, height: 1220, sheetCount: 2, parts: [0, 1].map(index => ({ number: `P00${index + 1}`, name: `Side ${index + 1}`, sheetIndex: index, rotation: 0, bounds: { minX: 10, minY: 10, maxX: 100, maxY: 100 }, paths: [[{ x: 10, y: 10 }, { x: 100, y: 100 }]], warnings: [], tabs: [{ points: [{ x: 20, y: 10 }, { x: 30, y: 10 }], center: { x: 25, y: 10 }, z: -6.2, inferred: false, operation: 'Outer' }] })) },
  },
})
describe('At Machine', () => {
  beforeEach(async () => { window.history.replaceState({}, '', '#machine'); mock.list.mockReset().mockResolvedValue([await makeRun()]); mock.load.mockReset().mockResolvedValue(await makeRun()); mock.change.mockReset().mockResolvedValue(undefined); mock.download.mockReset(); mock.recuts.mockReset().mockResolvedValue([]); mock.queueRecut.mockReset().mockImplementation(async (_owner, _runId, sheetIndex, partNumber) => makeRecut(sheetIndex, partNumber)) })
  afterEach(() => { cleanup(); window.history.replaceState({}, '', '/') })
  it('loads summaries only, then the selected export; switches physical sheets and downloads the unchanged file', async () => {
    render(<MachinePage userId="alice" />)
    fireEvent.click(await screen.findByRole('button', { name: /Rack/ }))
    await screen.findByRole('heading', { name: 'Rack' })
    expect(mock.list).toHaveBeenCalledWith('alice', 0, 'waiting', expect.any(AbortSignal))
    expect(mock.load).toHaveBeenCalledTimes(1)
    expect(screen.getByText('12.2 mm')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Sheet 1 cutting paths and tab locations' })).toBeInTheDocument()
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
  it('blocks a superseded waiting download and prints labels from the current plan', async () => {
    const run = await makeRun()
    const job = newProductionJob({ name: 'Rack', width: 1220, height: 1220, spacing: 10, borderSpacing: 10, instances: [], gcodeSettings: run.snapshot.programs })
    run.snapshot.jobId = job.id
    mock.load.mockResolvedValue(run)
    window.history.replaceState({}, '', `#machine/${id}`)
    const print = vi.fn(async () => {})
    render(<MachinePage userId="alice" jobs={[job]} onCurrentLabels={print} />)
    expect(await screen.findByRole('button', { name: 'Download NC' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('layout has changed')
    expect(screen.queryByRole('button', { name: 'Mark cutting' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Print labels' }))
    await waitFor(() => expect(print).toHaveBeenCalledWith(job.id, 0))
    expect(mock.download).not.toHaveBeenCalled()
  })
  it('opens the first occupied sheet when a revision excludes earlier cut sheets', async () => {
    const run = await makeRun()
    run.snapshot.files = [{ ...run.snapshot.files[1], sheetIndices: [1] }]
    run.snapshot.map.parts = run.snapshot.map.parts.slice(1)
    mock.load.mockResolvedValue(run)
    window.history.replaceState({}, '', `#machine/${id}`)
    render(<MachinePage userId="alice" />)
    expect(await screen.findByRole('combobox', { name: 'Physical sheet' })).toHaveValue('1')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Download NC' }))
    await waitFor(() => expect(mock.download).toHaveBeenCalledWith('two.nc', 'two.nc', 'application/x-gcode'))
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

  it('queues the selected part from the bed map and prevents repeated requests', async () => {
    window.history.replaceState({}, '', `#machine/${id}`)
    render(<MachinePage userId="alice" />)
    fireEvent.change(await screen.findByRole('combobox', { name: 'Physical sheet' }), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select P002 Side 2' }))
    const button = screen.getByRole('button', { name: 'Re-cut' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await screen.findByText('P002 added to the re-cut queue.')).toBeInTheDocument()
    expect(mock.queueRecut).toHaveBeenCalledExactlyOnceWith('alice', id, 1, 'P002')
    expect(screen.getByRole('button', { name: 'Queued for re-cut' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Queued for re-cut' }))
    expect(mock.queueRecut).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: 'View re-cut queue' })).toHaveAttribute('href', '#queue/recuts')
    expect(mock.change).not.toHaveBeenCalled()
    expect(mock.download).not.toHaveBeenCalled()
  })

  it('restores queued state and selects the source part when opening a queue link', async () => {
    window.history.replaceState({}, '', `#machine/${id}?sheet=2&part=P002`)
    mock.recuts.mockResolvedValue([makeRecut(1, 'P002')])
    render(<MachinePage userId="alice" />)
    expect(await screen.findByRole('heading', { name: 'P002 · Side 2' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Queued for re-cut' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Physical sheet' })).toHaveValue('1')
    expect(mock.recuts).toHaveBeenCalledWith('alice', id, expect.any(AbortSignal))
  })

  it('keeps failed requests retryable and blocks requests until queued parts have loaded', async () => {
    window.history.replaceState({}, '', `#machine/${id}`)
    mock.recuts.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([])
    mock.queueRecut.mockRejectedValueOnce(new Error('Save failed'))
    render(<MachinePage userId="alice" />)
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Select P001 Side 1' }), { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Offline')
    expect(screen.getByRole('button', { name: 'Re-cut' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry re-cut queue' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Re-cut' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Re-cut' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed')
    expect(screen.queryByText('P001 added to the re-cut queue.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Re-cut' }))
    expect(await screen.findByRole('button', { name: 'Queued for re-cut' })).toBeDisabled()
  })

  it('ignores a re-cut save that finishes after the operator navigates away', async () => {
    window.history.replaceState({}, '', `#machine/${id}`)
    let finish!: (entry: MachineRecut) => void
    mock.queueRecut.mockImplementation(() => new Promise<MachineRecut>(resolve => { finish = resolve }))
    render(<MachinePage userId="alice" />)
    fireEvent.click(await screen.findByRole('button', { name: 'P001 Side 1 1 tabs' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Re-cut' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Re-cut' }))
    expect(screen.getByRole('button', { name: 'Queuing...' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cutting Jobs' }))
    await screen.findByRole('heading', { name: 'Previous exports' })
    await act(async () => finish(makeRecut()))
    expect(screen.queryByText('P001 added to the re-cut queue.')).not.toBeInTheDocument()
  })
})
