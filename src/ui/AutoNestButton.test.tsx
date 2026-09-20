import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoNestButton } from './AutoNestButton'
import { testParts } from '../test/jobFixtures'
import type { Sheet } from '../models/Sheet'
import type { Part } from '../models/Part'

class TestWorker {
  static instances: TestWorker[] = []
  onmessage?: (event: { data: unknown }) => void
  onerror?: () => void
  onmessageerror?: () => void
  request?: { parts: Part[]; sheet: Sheet }
  terminate = vi.fn()
  postMessage = vi.fn((request: { parts: Part[]; sheet: Sheet }) => { this.request = request })
  constructor() { TestWorker.instances.push(this) }
  reply(data: unknown) { act(() => this.onmessage?.({ data })) }
}
const sheet: Sheet = { name: 'Test', width: 1220, height: 1220, spacing: 30, borderSpacing: 10, gcodeSettings: { safeZ: 20, startGcode: '', spindleStartGcode: '', endGcode: '' }, instances: [{ id: 'placed', partId: testParts[0].id, sheetIndex: 0, x: 10, y: 10, rotation: 0, locked: false }] }
const result = [{ ...sheet.instances[0], rotation: 37 }]
const start = () => { fireEvent.click(screen.getByRole('button', { name: 'Auto Nest' })); return TestWorker.instances.at(-1)! }

beforeEach(() => { TestWorker.instances = []; vi.stubGlobal('Worker', TestWorker); vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('background auto nesting', () => {
  it('runs only placed components in a worker, reports progress and applies a complete result once', () => {
    const onComplete = vi.fn(), onStatus = vi.fn()
    render(<AutoNestButton parts={testParts} sheet={sheet} accountId="alice" onComplete={onComplete} onStatus={onStatus} />)
    const worker = start()
    expect(worker.request?.parts).toEqual([testParts[0]])
    expect(screen.getByRole('button', { name: 'Auto Nest' })).toBeDisabled()
    worker.reply({ progress: { completed: 1, total: 1 } })
    expect(screen.getByText('Nesting 1/1')).toBeInTheDocument()
    expect(onComplete).not.toHaveBeenCalled()
    worker.reply({ instances: result })
    worker.reply({ instances: result })
    expect(onComplete).toHaveBeenCalledExactlyOnceWith(result)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(onStatus).toHaveBeenLastCalledWith(expect.stringContaining('1 part reoriented'))
    expect(sheet.instances[0].rotation).toBe(0)
  })

  it.each(['sheet', 'parts', 'account'] as const)('discards a stale result after %s changes', changed => {
    const onComplete = vi.fn(), onStatus = vi.fn()
    const props = { parts: testParts, sheet, accountId: 'alice', onComplete, onStatus }
    const view = render(<AutoNestButton {...props} />)
    const worker = start()
    view.rerender(<AutoNestButton {...props} {...(changed === 'sheet' ? { sheet: { ...sheet, width: 2000 } } : changed === 'parts' ? { parts: [...testParts] } : { accountId: 'bob' })} />)
    worker.reply({ instances: result })
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(onComplete).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Auto Nest' })).toBeEnabled()
  })

  it('cancels immediately and ignores an old worker after starting another run', () => {
    const onComplete = vi.fn()
    render(<AutoNestButton parts={testParts} sheet={sheet} onComplete={onComplete} onStatus={vi.fn()} />)
    const first = start()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel auto nesting' }))
    const second = start()
    first.reply({ instances: result })
    expect(onComplete).not.toHaveBeenCalled()
    second.reply({ instances: result })
    expect(onComplete).toHaveBeenCalledExactlyOnceWith(result)
  })

  it.each(['error', 'crash', 'timeout', 'unmount'] as const)('leaves the sheet untouched on %s', failure => {
    const onComplete = vi.fn(), onStatus = vi.fn()
    const view = render(<AutoNestButton parts={testParts} sheet={sheet} onComplete={onComplete} onStatus={onStatus} />)
    const worker = start()
    if (failure === 'error') worker.reply({ error: 'No valid placement' })
    if (failure === 'crash') act(() => worker.onerror?.())
    if (failure === 'timeout') act(() => vi.advanceTimersByTime(30000))
    if (failure === 'unmount') view.unmount()
    worker.reply({ instances: result })
    expect(onComplete).not.toHaveBeenCalled()
    expect(worker.terminate).toHaveBeenCalledOnce()
    if (failure !== 'unmount') expect(onStatus).toHaveBeenLastCalledWith(expect.stringContaining('unchanged'))
  })
})
