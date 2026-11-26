import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { createPackagingLabelPdf, packagingLabels, renderPackagingLabel } from './packagingLabels'
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='
const bytes = (blob: Blob) => new Promise<ArrayBuffer>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result as ArrayBuffer)
  reader.onerror = () => reject(reader.error)
  reader.readAsArrayBuffer(blob)
})

beforeEach(() => {
  vi.stubGlobal('Image', class {
    naturalWidth = 1000
    naturalHeight = 355
    onload?: () => void
    set src(_value: string) { queueMicrotask(() => this.onload?.()) }
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ scale: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), drawImage: vi.fn(), measureText: (text: string) => ({ width: text.length }) } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(png)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('packaging labels', () => {
  it.each(packagingLabels)('exports exact stock dimensions and copies for $title', async label => {
    const pdf = await PDFDocument.load(await bytes(await createPackagingLabelPdf(label, 3)))
    expect(pdf.getPageCount()).toBe(3)
    for (const page of pdf.getPages()) {
      expect(page.getWidth() * 25.4 / 72).toBeCloseTo(label.width)
      expect(page.getHeight() * 25.4 / 72).toBeCloseTo(label.height)
    }
  })
  it('includes the logo and complete drill guide instruction', async () => {
    const canvas = document.createElement('canvas')
    await renderPackagingLabel(canvas, packagingLabels[2])
    const ctx = canvas.getContext('2d')!
    expect(ctx.drawImage).toHaveBeenCalled()
    expect(ctx.fillText).toHaveBeenCalledWith('Drill Guide', 25, 14, 46)
    expect(ctx.fillText).toHaveBeenCalledWith('Pre-Drill all holes to 2mm', 25, 21, 46)
  })
  it.each([0, -1, 1.5, 101, NaN])('rejects invalid quantity %s', async quantity => {
    await expect(createPackagingLabelPdf(packagingLabels[0], quantity)).rejects.toThrow('quantity')
  })
})
