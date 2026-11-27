import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExportSnapshot } from '../machine/exportSnapshot'

export async function hydrateExportSnapshot(client: SupabaseClient, ownerId: string, id: string, stored: Record<string, unknown>, signal?: AbortSignal): Promise<ExportSnapshot> {
  if (stored?.version !== 1) throw new Error('Unsupported export snapshot. Reload the app.')
  if (stored.storage !== 'chunks-v1') return stored as unknown as ExportSnapshot
  const count = stored.chunkCount
  const hash = stored.sha256
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 256 || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid saved export manifest.')
  const chunks: string[] = []
  for (let start = 0; start < count; start += 4) {
    let query = client.from('cnc_machine_run_chunks').select('chunk_index,content').eq('owner_id', ownerId).eq('export_id', id).eq('payload_hash', hash).eq('chunk_count', count).gte('chunk_index', start).lt('chunk_index', Math.min(start + 4, count)).order('chunk_index')
    if (signal) query = query.abortSignal(signal)
    const { data, error } = await query
    if (error) throw new Error(error.message)
    if (data?.length !== Math.min(4, count - start) || data.some((row, offset) => row.chunk_index !== start + offset || typeof row.content !== 'string')) throw new Error('Saved export is incomplete. No cutting files were loaded.')
    chunks.push(...data.map(row => row.content as string))
  }
  const payload = chunks.join('')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== hash) throw new Error('Saved export checksum mismatch. No cutting files were loaded.')
  const snapshot = JSON.parse(payload) as ExportSnapshot
  if (snapshot.version !== 1 || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.map?.parts)) throw new Error('Invalid saved export.')
  return snapshot
}
