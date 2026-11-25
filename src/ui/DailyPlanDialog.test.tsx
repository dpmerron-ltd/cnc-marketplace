import type { ReportPlanningProgress } from '../jobs/planningProgress'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DailyPlanDialog } from './DailyPlanDialog'
import type { SheetWorkspace } from '../jobs/production'
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true
  })
})
afterEach(cleanup)
const result: SheetWorkspace = {
  activeId: 'job',
  jobs: [],
  dailyPlan: {
    date: '2026-11-25',
    createdAt: '',
    cuts: [],
    deferred: [],
    issues: ['#100: no matching SKU'],
    warnings: [],
    orders: [{ name: '#100', scheduled: 0, waiting: 0, cutting: 0, cut: 0, pending: 0 }]
  }
}
it('previews both machines and exclusions without saving until requested', async () => {
  const apply = vi.fn().mockResolvedValue(undefined),
    close = vi.fn()
  render(<DailyPlanDialog onPrepare={vi.fn().mockResolvedValue(result)} onApply={apply} onClose={close} />)
  expect(await screen.findByRole('heading', { name: 'Machine 1' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Machine 2' })).toBeInTheDocument()
  expect(screen.getByText('#100: no matching SKU')).toBeInTheDocument()
  expect(apply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save day plan' }))
  expect(apply).toHaveBeenCalledWith(result)
})
it('keeps failed saves visible and cancels outstanding preparation on close', async () => {
  let signal: AbortSignal | undefined
  const prepare = vi.fn(async (s: AbortSignal) => {
    signal = s
    return result
  })
  const view = render(
    <DailyPlanDialog
      onPrepare={prepare}
      onApply={vi.fn().mockRejectedValue(new Error('Jobs changed'))}
      onClose={vi.fn()}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Save day plan' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Jobs changed')
  view.unmount()
  expect(signal?.aborted).toBe(true)
})

it('shows estimated progress, remains below 100 until ready, and resets after retry', async () => {
  let report!: ReportPlanningProgress
  let resolve!: (workspace: SheetWorkspace) => void
  let reject!: (reason: Error) => void
  const prepare = vi.fn((_signal: AbortSignal, progress: ReportPlanningProgress) => {
    report = progress
    return new Promise<SheetWorkspace>((yes, no) => {
      resolve = yes
      reject = no
    })
  })
  render(<DailyPlanDialog onPrepare={prepare} onApply={vi.fn()} onClose={vi.fn()} />)
  expect(screen.getByRole('progressbar', { name: 'Day planning progress' })).toHaveAttribute('value', '0')
  act(() => report({ percent: 62, message: 'Nesting order 2 of 4' }))
  expect(screen.getByText('62%')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Nesting order 2 of 4')
  act(() => report({ percent: 100, message: 'Finishing' }))
  expect(screen.getByText('99%')).toBeInTheDocument()
  await act(async () => reject(new Error('Could not estimate a sheet')))
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '0')
  await act(async () => resolve(result))
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '100')
  expect(screen.getByText('Day plan ready')).toBeInTheDocument()
})
