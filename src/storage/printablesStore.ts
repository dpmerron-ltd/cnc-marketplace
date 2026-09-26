import { supabase } from './supabaseClient'
import { maxStlBytes, printableDetailsSchema, type PrintableAsset, type PrintableDetails, type StlInfo } from '../printing/types'

const bucket = 'cnc-printables'
export const printablesPageSize = 24
async function clientFor(userId: string) {
  if (!supabase) throw new Error('Cloud connection is not configured.')
  const { data, error } = await supabase.auth.getUser()
  if (error || data.user?.id !== userId) throw new Error('The signed-in account changed. Reload before continuing.')
  return supabase
}

export async function listPrintables(userId: string, filters: { search: string; purpose: string; item: string; page: number }, signal: AbortSignal) {
  const client = await clientFor(userId)
  let query = client.from('printable_assets').select('*', { count: 'exact' }).order('created_at', { ascending: false }).order('id').range(filters.page * printablesPageSize, (filters.page + 1) * printablesPageSize - 1)
  if (filters.search.trim()) query = query.ilike('name', `%${filters.search.trim().replace(/[\\%_]/g, '\\$&')}%`)
  if (filters.purpose) query = query.eq('purpose', filters.purpose)
  if (filters.item) query = query.eq('item_id', filters.item)
  const { data, error, count } = await query.abortSignal(signal)
  if (error) throw new Error(error.message)
  return { assets: (data ?? []) as PrintableAsset[], count: count ?? 0 }
}

export async function printableThumbnails(userId: string, assets: PrintableAsset[]) {
  if (!assets.length) return {} as Record<string, string>
  const client = await clientFor(userId)
  const { data, error } = await client.storage.from(bucket).createSignedUrls(assets.map(a => a.preview_path), 600)
  if (error) throw new Error(error.message)
  const urls: Record<string, string> = {}
  for (const row of data ?? []) if (row.path && row.signedUrl && !row.error) urls[row.path] = row.signedUrl
  return urls
}

export async function uploadPrintable(userId: string, id: string, details: PrintableDetails, file: File, preview: Blob, info: StlInfo): Promise<void> {
  const fields = printableDetailsSchema.parse(details)
  if (!/\.stl$/i.test(file.name) || /[/\\]/.test(file.name) || file.name.length > 240 || !file.size || file.size > maxStlBytes) throw new Error('Choose an STL file up to 25 MB with a filename under 240 characters.')
  if (preview.type !== 'image/png' || !preview.size || preview.size > 2 * 1024 * 1024) throw new Error('STL thumbnail could not be prepared.')
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid upload ID.')
  const stlPath = `${userId}/${id}/model.stl`, previewPath = `${userId}/${id}/preview.png`
  const client = await clientFor(userId)
  try {
    // Browser multipart uploads use the Blob's MIME type, not the contentType option.
    const stl = await client.storage.from(bucket).upload(stlPath, new Blob([file], { type: 'model/stl' }), { contentType: 'model/stl', upsert: false })
    if (stl.error) throw new Error(stl.error.message)
    await clientFor(userId)
    const image = await client.storage.from(bucket).upload(previewPath, preview, { contentType: 'image/png', upsert: false })
    if (image.error) throw new Error(image.error.message)
    await clientFor(userId)
    const { error } = await client.from('printable_assets').insert({ id, owner_id: userId, ...fields, filename: file.name, file_bytes: file.size, triangles: info.triangles, dimensions: info.dimensions })
    if (error) throw new Error(error.message)
  } catch (error) {
    // A lost insert response must not delete files that were successfully published.
    await clientFor(userId)
    const check = await client.from('printable_assets').select('id').eq('id', id).maybeSingle()
    if (check.data?.id === id) return
    if (check.error) throw new Error('Upload confirmation failed. Refresh the library before retrying; uploaded files have been retained.')
    await client.storage.from(bucket).remove([stlPath, previewPath])
    throw error
  }
}

export async function downloadPrintable(userId: string, asset: PrintableAsset): Promise<Blob> {
  const client = await clientFor(userId)
  const { data, error } = await client.storage.from(bucket).download(asset.stl_path)
  if (error || !data) throw new Error(error?.message ?? 'STL download failed.')
  await clientFor(userId)
  if (data.size !== asset.file_bytes || data.size > maxStlBytes) throw new Error('The downloaded file does not match the saved STL. Refresh and try again.')
  return data
}

export async function removePrintable(userId: string, asset: PrintableAsset): Promise<string | undefined> {
  if (asset.owner_id !== userId) throw new Error('Only the uploader can remove this file.')
  const client = await clientFor(userId)
  const { data, error } = await client.from('printable_assets').delete().eq('id', asset.id).eq('owner_id', userId).select('id').single()
  if (error || !data) throw new Error(error?.message ?? 'The file could not be removed. Refresh and try again.')
  const result = await client.storage.from(bucket).remove([asset.stl_path, asset.preview_path])
  return result.error ? 'Removed from the library, but stored file cleanup failed.' : undefined
}
