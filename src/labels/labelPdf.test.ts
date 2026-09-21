import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { createLabelPdf } from './labelPdf'
import type { PartLabel } from './partLabels'

const label: PartLabel = { instanceId: 'part-1', totalParts: 12, partNumber: 'P001', sheetNumber: 1, cutOrder: 1, component: 'Left side', job: 'Universal Van Rack 1000', order: '#1007', sku: 'VS-0003-P01', material: '12 mm plywood', item: 'Universal Van Rack 1000', x: 10, y: 10, rotation: 0 }
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
const bytes = (blob: Blob) => new Promise<ArrayBuffer>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result as ArrayBuffer)
  reader.onerror = () => reject(reader.error)
  reader.readAsArrayBuffer(blob)
})

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ scale: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), measureText: (text: string) => ({ width: text.length }) } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(png)
})
afterEach(() => vi.restoreAllMocks())

describe('label PDF export', () => {
  it('creates one exact 50 x 25 mm page per component', async () => {
    const labels = Array.from({ length: 12 }, (_, index) => ({ ...label, partNumber: `P${index + 1}` }))
    const blob = await createLabelPdf(labels, { width: 50, height: 25, format: 'single' })
    expect(blob.type).toBe('application/pdf')
    const pdf = await PDFDocument.load(await bytes(blob))
    expect(pdf.getPageCount()).toBe(12)
    expect(pdf.getTitle()).toBe('Universal Van Rack 1000 - Part labels')
    for (const page of pdf.getPages()) {
      expect(page.getWidth() * 25.4 / 72).toBeCloseTo(50)
      expect(page.getHeight() * 25.4 / 72).toBeCloseTo(25)
    }
  })
  it('paginates A4 grids without losing labels', async () => {
    const pdf = await PDFDocument.load(await bytes(await createLabelPdf(Array.from({ length: 31 }, () => label), { width: 50, height: 25, format: 'a4' })))
    expect(pdf.getPageCount()).toBe(2)
    expect(pdf.getPage(0).getWidth() * 25.4 / 72).toBeCloseTo(210)
    expect(pdf.getPage(0).getHeight() * 25.4 / 72).toBeCloseTo(297)
  })
  it('rejects empty sheets and invalid dimensions', async () => {
    await expect(createLabelPdf([], { width: 50, height: 25, format: 'single' })).rejects.toThrow('No parts')
    await expect(createLabelPdf([label], { width: 0, height: 25, format: 'single' })).rejects.toThrow('Label size')
  })
})
