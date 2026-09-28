import type { SupabaseClient } from '@supabase/supabase-js'
import type { ItemDocument } from '../src/documents/itemDocuments'
import { JobError, sha256 } from '../src/jobs/generateJob'
import type { DocumentRepository, DocumentUpload } from './documents'

const bucket = 'cnc-item-documents'
const conflict = () => new JobError('Document ID already exists with different content, metadata or uploader. Existing documents were not changed.', 409)
export function documentRepository(db: SupabaseClient): DocumentRepository {
  async function byId(id: string): Promise<ItemDocument | undefined> {
    const result = await db.from('item_documents').select('*').eq('id', id).maybeSingle()
    if (result.error) throw new Error('Document lookup failed.')
    return result.data ?? undefined
  }
  async function bytes(path: string) {
    const result = await db.storage.from(bucket).download(path)
    if (result.error || !result.data) throw new Error('Document download failed.')
    return new Uint8Array(await result.data.arrayBuffer())
  }
  async function replay(owner: string, itemId: string, row: ItemDocument, input: DocumentUpload) {
    if (row.owner_id !== owner || row.kind !== input.kind || row.filename !== input.filename || row.file_bytes !== input.bytes.length || row.pages !== input.pages) throw conflict()
    if (row.item_id !== itemId) {
      const family = await db.from('marketplace_items').select('id,version_family_id').in('id', [row.item_id, itemId])
      if (family.error || family.data?.length !== 2 || family.data[0].version_family_id !== family.data[1].version_family_id) throw conflict()
    }
    if (await sha256(await bytes(row.file_path)) !== await sha256(input.bytes)) throw conflict()
    return { document: row, created: false }
  }
  return {
    async itemDocuments(_owner, itemId, limit, offset) {
      const result = await db.from('item_documents').select('*').eq('item_id', itemId).order('created_at').order('id').range(offset, offset + limit - 1)
      if (result.error) throw new Error('Document list failed.')
      return result.data ?? []
    },
    async itemDocumentFile(_owner, itemId, id) {
      const row = await byId(id)
      if (!row || row.item_id !== itemId) return undefined
      const data = await bytes(row.file_path)
      if (data.length !== row.file_bytes) throw new Error('Document length does not match metadata.')
      return { document: row, bytes: data }
    },
    async uploadDocument(owner, itemId, input) {
      const previous = await byId(input.id)
      if (previous) return replay(owner, itemId, previous, input)
      const path = `${owner}/${input.id}/document.pdf`
      const upload = await db.storage.from(bucket).upload(path, input.bytes, { contentType: 'application/pdf', upsert: false })
      if (upload.error) {
        // Resume an identical pending upload, never overwrite its bytes.
        if (!('statusCode' in upload.error) || String(upload.error.statusCode) !== '409') throw new Error('Document upload failed.')
        if (await sha256(await bytes(path)) !== await sha256(input.bytes)) throw conflict()
      }
      const inserted = await db.rpc('update_item_version', { p_actor: owner, p_item: itemId, p_action: 'add_document', p_payload: { id: input.id, kind: input.kind, filename: input.filename, file_bytes: input.bytes.length, pages: input.pages } })
      if (inserted.error || !inserted.data) {
        const confirmed = await byId(input.id)
        if (confirmed) return replay(owner, itemId, confirmed, input)
        // Keep an unconfirmed file for same-ID retries; another request may be publishing it.
        throw new Error('Document publication unconfirmed. Retry with the same ID and content.')
      }
      const document = await byId(input.id)
      if (!document) throw new Error('Document publication unconfirmed. Retry with the same ID and content.')
      return { document, created: true }
    },
  }
}
