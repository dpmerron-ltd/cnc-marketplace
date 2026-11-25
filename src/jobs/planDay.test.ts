import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { planDay } from './planDay'
import type { DailyPlanInput } from './dailyPlan'
const worker = {
  onmessage: undefined as undefined | ((event: { data: unknown }) => void),
  onerror: undefined as undefined | (() => void),
  terminate: vi.fn(),
  postMessage: vi.fn()
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal(
    'Worker',
    vi.fn(function () {
      return worker
    })
  )
})
afterEach(() => vi.unstubAllGlobals())
it('forwards worker progress without resolving or terminating planning early', async () => {
  const progress = vi.fn(),
    finished = vi.fn()
  const result = planDay({} as DailyPlanInput, new AbortController().signal, progress)
  void result.then(finished)
  worker.onmessage!({ data: { progress: { percent: 78, message: 'Checking sheet 1 of 3' } } })
  await Promise.resolve()
  expect(progress).toHaveBeenCalledWith({ percent: 78, message: 'Checking sheet 1 of 3' })
  expect(finished).not.toHaveBeenCalled()
  expect(worker.terminate).not.toHaveBeenCalled()
  const workspace = { activeId: 'job', jobs: [] }
  worker.onmessage!({ data: { workspace } })
  await expect(result).resolves.toBe(workspace)
  expect(worker.terminate).toHaveBeenCalledOnce()
})
it('can still cancel after receiving progress', async () => {
  const abort = new AbortController()
  const result = planDay({} as DailyPlanInput, abort.signal, vi.fn())
  worker.onmessage!({ data: { progress: { percent: 70, message: 'Nesting' } } })
  abort.abort()
  await expect(result).rejects.toThrow('cancelled')
  expect(worker.terminate).toHaveBeenCalledOnce()
})
