import { z } from 'zod'
import { PDFDocument } from 'pdf-lib'
import { JobError } from '../src/jobs/generateJob'
import { maxDocumentBytes, type ItemDocument } from '../src/documents/itemDocuments'

export const documentBodyLimit = Math.ceil(maxDocumentBytes / 3) * 4 + 4096
const schema = z.strictObject({
  id: z.uuid(), kind: z.enum(['instructions', 'packing']),
  filename: z.string().min(5).max(240).regex(/\.pdf$/i).refine(name => !/[/\\\x00-\x1f\x7f]/.test(name)),
  dataBase64: z.string().min(4).max(Math.ceil(maxDocumentBytes / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
})
export interface DocumentUpload { id: string; kind: ItemDocument['kind']; filename: string; bytes: Uint8Array; pages: number }
export interface DocumentRepository {
  itemDocuments(owner: string, itemId: string, limit: number, offset: number): Promise<ItemDocument[]>
  uploadDocument(owner: string, itemId: string, input: DocumentUpload): Promise<{ document: ItemDocument; created: boolean }>
  itemDocumentFile(owner: string, itemId: string, id: string): Promise<{ document: ItemDocument; bytes: Uint8Array } | undefined>
}
export async function parseDocument(value: unknown): Promise<DocumentUpload> {
  const result = schema.safeParse(value)
  if (!result.success) throw new JobError('Supply a stable UUID id, kind (instructions or packing), PDF filename and dataBase64.', 400)
  const { dataBase64, ...fields } = result.data
  const bytes = Uint8Array.from(atob(dataBase64), character => character.charCodeAt(0))
  if (!bytes.length || bytes.length > maxDocumentBytes) throw new JobError('PDF exceeds 20 MB.', 413)
  let pdf
  try { pdf = await PDFDocument.load(bytes) } catch { throw new JobError('Upload a readable, unencrypted PDF without password protection.', 422) }
  const pages = pdf.getPageCount()
  if (!pages || pages > 200) throw new JobError('PDFs must contain 1-200 pages.', 422)
  return { ...fields, bytes, pages }
}
