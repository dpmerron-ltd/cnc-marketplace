export const documentKinds = { instructions: 'User instructions', packing: 'Packing list' } as const
export type DocumentKind = keyof typeof documentKinds
export const maxDocumentBytes = 20 * 1024 * 1024
export interface ItemDocument {
  id: string
  item_id: string
  owner_id: string
  kind: DocumentKind
  filename: string
  file_bytes: number
  pages: number
  file_path: string
  created_at: string
}

export async function inspectPdf(file: File): Promise<number> {
  if (!/\.pdf$/i.test(file.name) || /[/\\]/.test(file.name) || file.name.length > 240 || !file.size || file.size > maxDocumentBytes) throw new Error('Choose a PDF up to 20 MB with a filename under 240 characters.')
  const { PDFDocument } = await import('pdf-lib')
  let pdf
  try { pdf = await PDFDocument.load(new Uint8Array(await file.arrayBuffer())) }
  catch { throw new Error('This PDF cannot be read. Upload an unencrypted PDF without password protection.') }
  const pages = pdf.getPageCount()
  if (!pages || pages > 200) throw new Error('PDFs must contain between 1 and 200 pages.')
  return pages
}

export async function createPrintPacket(entries: { document: ItemDocument; copies: number }[], download: (document: ItemDocument) => Promise<Blob>): Promise<Blob> {
  if (!entries.length) throw new Error('Select at least one document.')
  if (entries.some(e => !Number.isSafeInteger(e.copies) || e.copies < 1 || e.copies > 100)) throw new Error('Choose between 1 and 100 copies per document.')
  if (entries.reduce((sum, e) => sum + e.document.pages * e.copies, 0) > 500) throw new Error('Print at most 500 pages at a time. Reduce the copies or selection.')
  if (entries.reduce((sum, e) => sum + e.document.file_bytes, 0) > 100 * 1024 * 1024) throw new Error('Print at most 100 MB of documents at a time.')
  const { PDFDocument } = await import('pdf-lib')
  const packet = await PDFDocument.create()
  let pages = 0
  for (const entry of entries) {
    const source = await PDFDocument.load(new Uint8Array(await (await download(entry.document)).arrayBuffer()))
    pages += source.getPageCount() * entry.copies
    if (!source.getPageCount() || pages > 500) throw new Error('PDF packet exceeds the 500-page limit.')
    for (let copy = 0; copy < entry.copies; copy++) {
      const copied = await packet.copyPages(source, source.getPageIndices())
      for (const page of copied) packet.addPage(page)
    }
  }
  return new Blob([new Uint8Array(await packet.save())], { type: 'application/pdf' })
}
