import { describe, expect, it, vi } from 'vitest'
import { Blob, File } from 'node:buffer'
import { PDFDocument, degrees } from 'pdf-lib'
import { createPrintPacket, inspectPdf, type ItemDocument } from './itemDocuments'
const document: ItemDocument = { id: 'd', item_id: 'i', owner_id: 'a', kind: 'instructions', filename: 'manual.pdf', file_bytes: 100, pages: 2, file_path: 'a/d/document.pdf', created_at: '' }
async function fixture() {
  const pdf = await PDFDocument.create()
  pdf.addPage([210, 300]); pdf.addPage([400, 200]).setRotation(degrees(90))
  return new Uint8Array(await pdf.save())
}
describe('item document PDFs', () => {
  it('validates actual PDF contents and counts pages', async () => {
    const file = new File([await fixture()], 'manual.pdf')
    expect(await inspectPdf(file as unknown as globalThis.File)).toBe(2)
    await expect(inspectPdf(new File(['bad'], 'bad.pdf') as unknown as globalThis.File)).rejects.toThrow('cannot be read')
    await expect(inspectPdf(new File(['bad'], 'bad.docx') as unknown as globalThis.File)).rejects.toThrow('Choose a PDF')
  })
  it('preserves page order, dimensions, rotation and complete copies', async () => {
    vi.stubGlobal('Blob', Blob)
    try {
      const bytes = await fixture()
      const download = vi.fn(async () => new Blob([bytes]) as unknown as globalThis.Blob)
      const result = await createPrintPacket([{ document, copies: 2 }], download)
      const pdf = await PDFDocument.load(new Uint8Array(await result.arrayBuffer()))
      expect(pdf.getPages().map(p => [p.getWidth(), p.getHeight(), p.getRotation().angle])).toEqual([[210, 300, 0], [400, 200, 90], [210, 300, 0], [400, 200, 90]])
      expect(download).toHaveBeenCalledTimes(1)
    } finally { vi.unstubAllGlobals() }
  })
  it('blocks empty selections, excessive jobs and invalid quantities before downloading', async () => {
    const download = vi.fn()
    for (const copies of [0, -1, 1.5, 101, NaN]) await expect(createPrintPacket([{ document, copies }], download)).rejects.toThrow('copies')
    await expect(createPrintPacket([], download)).rejects.toThrow('Select')
    await expect(createPrintPacket([{ document: { ...document, pages: 200 }, copies: 3 }], download)).rejects.toThrow('500 pages')
    expect(download).not.toHaveBeenCalled()
  })
  it('never silently skips a failed document download', async () => {
    await expect(createPrintPacket([{ document, copies: 1 }], async () => { throw new Error('Download failed') })).rejects.toThrow('Download failed')
  })
})
