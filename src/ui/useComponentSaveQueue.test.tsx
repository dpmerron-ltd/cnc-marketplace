import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { testParts } from '../test/jobFixtures'
import { useComponentSaveQueue } from './useComponentSaveQueue'

const part = { ...testParts[0], ownerId: 'alice' }
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('background component saves', () => {
  it('serializes saves, snapshots data and retries failures with the original ID and content', async () => {
    const first = deferred(), second = deferred()
    const save = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise).mockResolvedValue(undefined)
    const { result } = renderHook(() => useComponentSaveQueue('alice', save), { wrapper: StrictMode })
    const source = { ...part }
    act(() => { result.current.enqueue(source, 'First item'); result.current.enqueue({ ...part, id: 'second' }, 'Second item'); result.current.enqueue(source, 'Duplicate') })
    source.gcode = 'changed after confirmation'
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0][0].gcode).toBe(part.gcode)
    expect(result.current.jobs.map(job => job.status)).toEqual(['saving', 'queued'])
    const leave = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leave)
    expect(leave.defaultPrevented).toBe(true)
    await act(async () => first.reject(new Error('Offline')))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(result.current.jobs[0]).toMatchObject({ status: 'failed', error: 'Offline' })
    act(() => result.current.retry(part.id))
    expect(save).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve())
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3))
    expect(save.mock.calls[2][0]).toEqual(save.mock.calls[0][0])
    await waitFor(() => expect(result.current.jobs.every(job => job.status === 'saved')).toBe(true))
    expect(result.current.jobs.every(job => !job.part)).toBe(true)
    const done = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(done)
    expect(done.defaultPrevented).toBe(false)
    act(() => result.current.clearSaved())
    expect(result.current.jobs).toEqual([])
  })

  it('does not start queued saves or expose results after switching accounts', async () => {
    const pending = deferred(), save = vi.fn(() => pending.promise)
    const { result, rerender } = renderHook(({ owner }) => useComponentSaveQueue(owner, save), { initialProps: { owner: 'alice' } })
    act(() => { result.current.enqueue(part, 'Private'); result.current.enqueue({ ...part, id: 'queued' }, 'Private') })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    rerender({ owner: 'bob' })
    expect(result.current.jobs).toEqual([])
    expect(() => result.current.enqueue(part, 'Private')).toThrow('current account')
    await act(async () => pending.resolve())
    expect(save).toHaveBeenCalledTimes(1)
    expect(result.current.jobs).toEqual([])
  })
})
