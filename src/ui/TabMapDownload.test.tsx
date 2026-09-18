import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TabMapDownload } from './TabMapDownload'
import { buildTabMap } from '../printing/tabMap'
import { createTabMapPdf } from '../printing/tabMapPdf'
import { testParts } from '../test/jobFixtures'
import type { Sheet } from '../models/Sheet'
import { defaultProgramSettings } from '../gcode/programSettings'

vi.mock('../printing/tabMap', () => ({ buildTabMap: vi.fn(() => ({ name: 'Snapshot' })) }))
vi.mock('../printing/tabMapPdf', () => ({ createTabMapPdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])) }))
const sheet: Sheet = { name: 'Job 42', width: 1220, height: 2440, spacing: 30, borderSpacing: 10, instances: [{ id: 'one', partId: testParts[0].id, sheetIndex: 0, x: 10, y: 10, rotation: 0, locked: false }], gcodeSettings: { ...defaultProgramSettings, safeZ: 20 } }

describe('Tab map PDF download', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) })))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    URL.createObjectURL = vi.fn(() => 'blob:test-pdf')
    URL.revokeObjectURL = vi.fn()
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
  it('downloads a PDF from the reviewed snapshot without modifying or exporting G-code', async () => {
    render(<TabMapDownload parts={testParts} sheet={sheet} />)
    fireEvent.click(screen.getByRole('button', { name: 'Tab map PDF' }))
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce())
    expect(buildTabMap).toHaveBeenCalledExactlyOnceWith(testParts, sheet)
    expect(createTabMapPdf).toHaveBeenCalledOnce()
    const anchor = vi.mocked(HTMLAnchorElement.prototype.click).mock.instances[0] as HTMLAnchorElement
    expect(anchor.download).toBe('Job-42-tab-map.pdf')
    expect(screen.getByRole('button', { name: 'Tab map PDF' })).toBeEnabled()
  })
  it('reports font download failures and allows a retry', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response)
    render(<TabMapDownload parts={testParts} sheet={sheet} />)
    fireEvent.click(screen.getByRole('button', { name: 'Tab map PDF' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the PDF font')
    expect(createTabMapPdf).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Tab map PDF' }))
    await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('prevents duplicate clicks and cancels the download after closing or switching accounts', async () => {
    let finish!: (value: Uint8Array) => void
    vi.mocked(createTabMapPdf).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<TabMapDownload parts={testParts} sheet={sheet} />)
    const button = screen.getByRole('button', { name: 'Tab map PDF' })
    fireEvent.click(button); fireEvent.click(button)
    await waitFor(() => expect(createTabMapPdf).toHaveBeenCalledOnce())
    expect(button).toBeDisabled()
    view.unmount()
    await act(async () => finish(new Uint8Array([1])))
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })
  it('disables empty sheets', () => {
    render(<TabMapDownload parts={testParts} sheet={{ ...sheet, instances: [] }} />)
    expect(screen.getByRole('button', { name: 'Tab map PDF' })).toBeDisabled()
  })
})
