import { supabase } from './supabaseClient'
import { saveCatalogueItem, updateRemoteItem } from './supabaseProjectStore'
import { itemFamily } from '../models/itemVersions'
import type { MarketplaceItem } from '../models/Item'
import { inspectPdf, maxDocumentBytes, type DocumentKind, type ItemDocument } from '../documents/itemDocuments'

const bucket = 'cnc-item-documents'
async function clientFor(userId: string) {
  if (!supabase) throw new Error('Cloud connection is not configured.')
  const { data, error } = await supabase.auth.getUser()
  if (error || data.user?.id !== userId) throw new Error('The signed-in account changed. Reload before continuing.')
  return supabase
}

export async function listItemDocuments(userId: string, itemId: string, signal: AbortSignal): Promise<ItemDocument[]> {
  const client = await clientFor(userId)
  const rows: ItemDocument[] = []
  for (let from = 0; ; from += 100) {
    const { data, error } = await client.from('item_documents').select('*').eq('item_id', itemId).order('created_at').order('id').range(from, from + 99).abortSignal(signal)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []) as ItemDocument[])
    if ((data?.length ?? 0) < 100) break
  }
  await clientFor(userId)
  return rows
}

export async function uploadItemDocument(userId: string, item: MarketplaceItem, kind: DocumentKind, file: File): Promise<void> {
  if (kind !== 'instructions' && kind !== 'packing') throw new Error('Choose a document type.')
  const pages = await inspectPdf(file)
  const client = await clientFor(userId)
  const saved = await saveCatalogueItem(item, userId)
  if (!saved.ok) throw new Error(saved.error)
  const id = crypto.randomUUID(), path = `${userId}/${id}/document.pdf`
  try {
    await clientFor(userId)
    const upload = await client.storage.from(bucket).upload(path, new Blob([file], { type: 'application/pdf' }), { contentType: 'application/pdf', upsert: false })
    if (upload.error) throw new Error(upload.error.message)
    await clientFor(userId)
    await updateRemoteItem(userId, itemFamily(item), 'add_document', { id, kind, filename: file.name, file_bytes: file.size, pages })
  } catch (error) {
    await clientFor(userId)
    const check = await client.from('item_documents').select('id').eq('id', id).maybeSingle()
    if (check.data?.id === id) return
    if (check.error) throw new Error('Upload confirmation failed. Refresh before retrying; uploaded files have been retained.')
    await client.storage.from(bucket).remove([path])
    throw error
  }
}

export async function downloadItemDocument(userId: string, document: ItemDocument): Promise<Blob> {
  const client = await clientFor(userId)
  const { data, error } = await client.storage.from(bucket).download(document.file_path)
  if (error || !data) throw new Error(error?.message ?? 'PDF download failed.')
  await clientFor(userId)
  if (data.size !== document.file_bytes || data.size > maxDocumentBytes) throw new Error('PDF does not match the saved document. Refresh and try again.')
  return new Blob([data], { type: 'application/pdf' })
}

export async function removeItemDocument(userId: string, document: ItemDocument): Promise<string | undefined> {
  if (document.owner_id !== userId) throw new Error('Only the uploader can remove this document.')
  await clientFor(userId)
  await updateRemoteItem(userId, document.item_id, 'remove_document', { id: document.id })
  return undefined
}
