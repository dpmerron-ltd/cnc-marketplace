import { hydrateExportSnapshot } from './chunkedSnapshot'
import { ncHash } from '../machine/exportSnapshot'
import { supabase } from './supabaseClient'
import type { ExportSnapshot, MachineRun, MachineRunSummary, MachineStatus } from '../machine/exportSnapshot'

const summaryColumns = 'id,owner_id,name,order_number,material,thickness,sheet_count,part_count,status,created_at'
async function clientFor(ownerId: string) {
  if (!supabase) throw new Error('Cloud connection is not configured.')
  const { data, error } = await supabase.auth.getUser()
  if (error || data.user?.id !== ownerId) throw new Error('The signed-in account changed. Reload before continuing.')
  return supabase
}

export async function saveMachineRun(id: string, ownerId: string, snapshot: ExportSnapshot): Promise<void> {
  const client = await clientFor(ownerId)
  const payload = JSON.stringify(snapshot)
  if (new TextEncoder().encode(payload).byteLength > 128 * 1024 * 1024) throw new Error('Export exceeds 128 MiB. Export fewer sheets at a time.')
  // JSON escapes lone surrogates. Avoid splitting a valid surrogate pair between
  // requests, so the server receives exactly the UTF-8 bytes we hashed.
  const chunks: string[] = []
  for (let start = 0; start < payload.length;) {
    let end = Math.min(start + 1024 * 1024, payload.length)
    const last = payload.charCodeAt(end - 1)
    if (end < payload.length && last >= 0xd800 && last <= 0xdbff) end--
    chunks.push(payload.slice(start, end))
    start = end
  }
  const hash = await ncHash(payload)
  for (const [index, content] of chunks.entries()) {
    const { data, error } = await client.rpc('upload_cnc_machine_run_chunk', {
      p_id: id, p_index: index, p_count: chunks.length, p_hash: hash, p_content: content,
    })
    if (error || data !== id) throw new Error(error?.message ?? 'The export upload was not saved.')
  }
  const { data, error } = await client.rpc('finish_cnc_machine_run_upload', { p_id: id, p_count: chunks.length, p_hash: hash })
  if (error || data !== id) throw new Error(error?.message ?? 'The exported sheet was not saved.')
}

export async function listMachineRuns(ownerId: string, offset: number, status: string, signal: AbortSignal): Promise<MachineRunSummary[]> {
  const client = await clientFor(ownerId)
  let query = client.from('cnc_machine_runs').select(summaryColumns).eq('owner_id', ownerId).order('created_at', { ascending: false }).order('id').range(offset, offset + 24)
  if (status) query = query.eq('status', status)
  const { data, error } = await query.abortSignal(signal)
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function loadMachineRun(ownerId: string, id: string, signal: AbortSignal): Promise<MachineRun> {
  const client = await clientFor(ownerId)
  const { data, error } = await client.from('cnc_machine_runs').select(`${summaryColumns},snapshot`).eq('owner_id', ownerId).eq('id', id).abortSignal(signal).single()
  if (error || !data) throw new Error(error?.message ?? 'Exported sheet not found.')
  return { ...data, snapshot: await hydrateExportSnapshot(client, ownerId, id, data.snapshot, signal) }
}

export async function changeMachineRunStatus(ownerId: string, run: MachineRun, status: MachineStatus): Promise<void> {
  const client = await clientFor(ownerId)
  const { data, error } = await client.from('cnc_machine_runs').update({ status }).eq('owner_id', ownerId).eq('id', run.id).eq('status', run.status).select('id').single()
  if (error || !data) throw new Error(error?.message ?? 'This export changed on another device. Refresh before updating it.')
}
