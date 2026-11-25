import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
