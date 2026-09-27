// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { parseDocument } from './documents'
const id = '10000000-0000-4000-8000-000000000001'
describe('document upload validation', () => {
  it('counts the PDF pages and retains the original bytes', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage([200, 300]); pdf.addPage([300, 200])
    const bytes = await pdf.save()
    const result = await parseDocument({ id, kind: 'packing', filename: 'packing.pdf', dataBase64: Buffer.from(bytes).toString('base64') })
    expect(result.pages).toBe(2); expect(result.bytes).toEqual(bytes)
  })
  it('rejects invalid metadata, base64, unreadable PDFs and empty PDFs', async () => {
    const input = { id, kind: 'instructions', filename: 'guide.pdf', dataBase64: Buffer.from('not a pdf').toString('base64') }
    await expect(parseDocument(input)).rejects.toMatchObject({ status: 422 })
    for (const patch of [{ id: 'wrong' }, { kind: 'other' }, { filename: '../guide.pdf' }, { filename: 'a\r\nb.pdf' }, { dataBase64: '???' }]) await expect(parseDocument({ ...input, ...patch })).rejects.toMatchObject({ status: 400 })
    const pdf = await PDFDocument.create()
    const bytes = await pdf.save({ addDefaultPage: false })
    await expect(parseDocument({ ...input, dataBase64: Buffer.from(bytes).toString('base64') })).rejects.toMatchObject({ status: 422 })
  })
})
