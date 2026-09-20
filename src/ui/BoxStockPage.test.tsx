import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoxStockPage } from './BoxStockPage'
import { jobApiRequest } from '../storage/jobsApi'
import { useBoxStock } from '../storage/useBoxStock'

vi.mock('../storage/jobsApi', () => ({ jobApiRequest: vi.fn() }))
vi.mock('../storage/useBoxStock', () => ({ useBoxStock: vi.fn() }))
vi.mock('../packing/usePackingEstimates', () => ({ usePackingEstimates: () => ({}) }))
const box = { id: '00000000-0000-4000-8000-000000000001', name: '105 x 35 x 40 cm', length_mm: 1050, width_mm: 350, height_mm: 400, quantity: 10, version: 3, updated_at: '', details: 'Internal dimensions.' }
const reload = vi.fn()
beforeEach(() => {
  reload.mockClear()
  vi.mocked(useBoxStock).mockReturnValue({ boxes: [box], loading: false, reload, error: undefined })
  vi.mocked(jobApiRequest).mockReset().mockResolvedValue({} as Response)
})
afterEach(cleanup)
describe('Box inventory', () => {
  it('only changes stock after saving, with the expected version and account', async () => {
    render(<BoxStockPage userId="alice" items={[]} parts={[]} />)
    expect(jobApiRequest).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('spinbutton', { name: /Stock count for/ }), { target: { value: '9' } })
    expect(jobApiRequest).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Save stock count for/ }))
    await waitFor(() => expect(reload).toHaveBeenCalled())
    expect(jobApiRequest).toHaveBeenCalledWith(`/boxes/${box.id}`, 'alice', { method: 'PATCH', body: JSON.stringify({ quantity: 9, expectedVersion: 3 }) })
  })
  it('does not retry or silently overwrite a concurrent count change', async () => {
    vi.mocked(jobApiRequest).mockRejectedValue(new Error('Box stock changed. Refresh before updating the count.'))
    render(<BoxStockPage userId="alice" items={[]} parts={[]} />)
    fireEvent.change(screen.getByRole('spinbutton', { name: /Stock count for/ }), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: /Save stock count for/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Box stock changed')
    expect(jobApiRequest).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
  })
  it('stores newly entered cm dimensions as mm and allows zero initial stock', async () => {
    render(<BoxStockPage userId="alice" items={[]} parts={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add box size' }))
    for (const [label, value] of [['Name', 'Compact'], ['Internal length (cm)', '105'], ['Internal width (cm)', '35'], ['Internal height (cm)', '15']]) fireEvent.change(screen.getByLabelText(label), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: 'Save box' }))
    await waitFor(() => expect(reload).toHaveBeenCalled())
    const [path, owner, options] = vi.mocked(jobApiRequest).mock.calls[0]
    expect([path, owner]).toEqual(['/boxes', 'alice'])
    expect(JSON.parse(options!.body as string)).toMatchObject({ name: 'Compact', length_mm: 1050, width_mm: 350, height_mm: 150, quantity: 0 })
  })
})
