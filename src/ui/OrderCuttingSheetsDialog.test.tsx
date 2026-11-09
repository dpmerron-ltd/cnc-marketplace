import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProductionJob, sheetSignature } from '../jobs/production'
import { addition, hex, materialSheet } from '../test/materialFixtures'
import { OrderCuttingSheetsDialog } from './OrderCuttingSheetsDialog'

const order = { key: 'shop/gid://shopify/Order/123', name: '#1001' }
function fixture() {
  const job = { ...newProductionJob(materialSheet()), name: '2026-11-09-001' }
  job.sheet.instances = [
    { ...addition('panel'), id: 'own', orderKey: order.key, sheetIndex: 2, materialSetup: { stockMaterial: hex, materialProfile: '12' as const } },
    { ...addition('panel'), id: 'other', sheetIndex: 2 },
    { ...addition('panel'), id: 'finished', orderKey: order.key, sheetIndex: 0 },
  ]
  job.sheets[0] = { stage: 'cut', runId: 'finished-run', signature: sheetSignature(job.sheet, 0) }
  job.sheets[2] = { stage: 'waiting', runId: 'current-run', signature: sheetSignature(job.sheet, 2) }
  return job
}
beforeEach(() => { HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true }) })
afterEach(cleanup)

describe('order cutting sheets', () => {
  it('shows outstanding sheets, material and shared parts, then opens the exact sheet', () => {
    const job = fixture(), onOpen = vi.fn(), onClose = vi.fn()
    render(<OrderCuttingSheetsDialog order={order} jobs={[job]} onOpen={onOpen} onClose={onClose} />)
    expect(screen.getByRole('dialog', { name: 'Cutting sheets for #1001' })).toBeInTheDocument()
    expect(screen.getByText('1 sheet still needs cutting.')).toBeInTheDocument()
    expect(screen.getByText('12 mm Plywood · Black Hex')).toBeInTheDocument()
    expect(screen.getByText('Shared sheet: includes 1 other part. Cut the complete sheet.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sheet 1' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Cutting file' })).toHaveAttribute('href', '#machine/current-run?sheet=3')
    fireEvent.click(screen.getByRole('button', { name: 'Open sheet' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(onOpen).toHaveBeenCalledWith(job.id, 2)
  })

  it('keeps changed files unavailable, shows pending allocation and reveals cut history on request', () => {
    const job = fixture(), onOpen = vi.fn()
    job.sheet.instances[0].x += 10
    job.sheet.pendingParts = [{ ...addition('panel'), orderKey: order.key }]
    render(<OrderCuttingSheetsDialog order={order} jobs={[job]} onOpen={onOpen} onClose={vi.fn()} />)
    expect(screen.getByText('Waiting · needs export')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Cutting file' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Parts awaiting allocation' })).toHaveTextContent('1 part without a sheet')
    fireEvent.click(screen.getByRole('button', { name: 'Open job to allocate' }))
    expect(onOpen).toHaveBeenCalledWith(job.id, undefined)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show cut sheets (1)' }))
    const cut = screen.getByRole('article', { name: `${job.name}, Sheet 1` })
    expect(within(cut).getByText('Cut', { exact: true })).toBeInTheDocument()
    expect(within(cut).getByRole('link', { name: 'Cutting file' })).toHaveAttribute('href', '#machine/finished-run?sheet=1')
  })

  it('does not call an unplanned order complete', () => {
    render(<OrderCuttingSheetsDialog order={order} jobs={[]} onOpen={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText(/No sheets are planned for this order/)).toBeInTheDocument()
    expect(screen.queryByText('All planned sheets are cut.')).not.toBeInTheDocument()
  })
})
