import type { SupabaseClient } from '@supabase/supabase-js'
import { JobError, sha256 } from '../src/jobs/generateJob'
import type { ItemImportRepository, ItemImportStatus } from './itemImports'

export function itemImportRepository(db: SupabaseClient): ItemImportRepository {
  async function rpc(name: string, input: Record<string, unknown>): Promise<ItemImportStatus> {
    const result = await db.rpc(name, input)
    if (result.error) {
      const message = result.error.message
      if (/IMPORT_NOT_FOUND/.test(message)) throw new JobError('Import not found in this account and item.', 404)
      if (/IMPORT_FORBIDDEN/.test(message)) throw new JobError('Import access denied.', 403)
      if (/IMPORT_CONFLICT/.test(message)) throw new JobError('Import or default version changed. Existing versions were not modified.', 409)
      if (/IMPORT_INCOMPLETE|IMPORT_INVALID/.test(message)) throw new JobError('Import is incomplete or invalid. Supply every declared component, all cutting profiles and PDFs before publishing.', 422)
      throw new Error('Item import operation failed.')
    }
    return result.data
  }
  const args = (owner: string, item: string, id: string) => ({ p_actor: owner, p_item: item, p_id: id })
  const status = (owner: string, item: string, id: string) => rpc('read_item_import', args(owner, item, id))
  return {
    beginItemImport: (owner, item, input) => rpc('begin_item_import', { ...args(owner, item, input.id), p_manifest: input }),
    itemImport: status,
    stageItemImport: (owner, item, id, kind, key, payload) => rpc('stage_item_import', { ...args(owner, item, id), p_kind: kind, p_key: key, p_payload: payload }),
    publishItemImport: (owner, item, id) => rpc('publish_item_import', args(owner, item, id)),
    async stageImportDocument(owner, item, id, input) {
      const current = await status(owner, item, id)
      if (!current.documentIds.includes(input.id)) throw new JobError('Document was not declared in this import.', 422)
      const bucket = db.storage.from('cnc-item-documents'), path = `${owner}/${input.id}/document.pdf`
      const digest = await sha256(input.bytes)
      // Immutable storage and stage payloads make uncertain retries safe.
      const uploaded = await bucket.upload(path, input.bytes, { contentType: 'application/pdf', upsert: false })
      if (uploaded.error) {
        if (!('statusCode' in uploaded.error) || String(uploaded.error.statusCode) !== '409') throw new Error('Import PDF upload failed.')
        const existing = await bucket.download(path)
        if (existing.error || !existing.data || await sha256(new Uint8Array(await existing.data.arrayBuffer())) !== digest) throw new JobError('PDF ID already has different bytes.', 409)
      }
      return rpc('stage_item_import', { ...args(owner, item, id), p_kind: 'document', p_key: input.id, p_payload: { id: input.id, kind: input.kind, filename: input.filename, file_bytes: input.bytes.length, pages: input.pages, sha256: digest } })
    },
  }
}
