import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { DailyPlanPanel } from './DailyPlanPanel'
import type { DailyPlan, ScheduledCut } from '../jobs/dailyPlan'
afterEach(cleanup)
const cut: ScheduledCut = {
  jobId: 'job',
  sheetIndex: 0,
  sheetWidthMm: 1220,
  sheetHeightMm: 1220,
  signature: '',
  orders: ['#1', '#2'],
  material: '12 mm Plywood · Black Hex',
  materialKey: 'hex',
  placedAt: 0,
  seconds: 3600,
  parts: 5,
  machine: 1,
  startMinute: 555,
  endMinute: 615
}
const plan: DailyPlan = {
  date: '2026-11-25',
  createdAt: '',
  cuts: [cut, { ...cut, sheetIndex: 1, machine: 2 }],
  deferred: [{ ...cut, sheetIndex: 2 }],
  orders: [],
  issues: [],
  warnings: []
}
it('shows the combined material tally in squares, excluding deferred sheets', () => {
  render(<DailyPlanPanel plan={plan} />)
  const table = screen.getByRole('table', { name: 'Material needed today' })
  expect(within(table).getByRole('columnheader', { name: '1220 × 1220 mm squares' })).toBeInTheDocument()
  expect(within(table).getByRole('row', { name: '12 mm Plywood · Black Hex 2' })).toBeInTheDocument()
  expect(within(table).getByRole('row', { name: 'Total squares 2' })).toBeInTheDocument()
})
it('shows an incomplete tally when legacy layouts need review', () => {
  render(<DailyPlanPanel plan={{ ...plan, cuts: [{ ...cut, sheetWidthMm: 2440 }] }} />)
  expect(screen.getByRole('alert')).toHaveTextContent('not included in the square total')
  expect(screen.getByRole('row', { name: 'Confirmed total 0 1' })).toBeInTheDocument()
})
