import { supabase } from './supabaseClient'
import type { MachineRecut, RecutStatus } from '../machine/recuts'

const columns = 'id,owner_id,source_run_id,sheet_index,part_number,part_name,job_name,order_number,material,thickness,status,created_at,updated_at'

async function clientFor(ownerId: string) {
  if (!supabase) throw new Error('Cloud connection is not configured.')
  const { data, error } = await supabase.auth.getUser()
  if (error || data.user?.id !== ownerId) throw new Error('The signed-in account changed. Reload before continuing.')
  return supabase
}

export async function queueMachineRecut(ownerId: string, runId: string, sheetIndex: number, partNumber: string): Promise<MachineRecut> {
  const client = await clientFor(ownerId)
  // Names and stock details come from the immutable export in the database.
  const { data, error } = await client.from('cnc_machine_recuts').insert({ owner_id: ownerId, source_run_id: runId, sheet_index: sheetIndex, part_number: partNumber }).select(columns).single()
  if (!error && data) return data
  if (error?.code !== '23505') throw new Error(error?.message ?? 'The part could not be queued. Try again.')
  // Another click/device or a retry after a lost response refers to the same pending re-cut.
  const existing = await client.from('cnc_machine_recuts').select(columns).eq('owner_id', ownerId).eq('source_run_id', runId).eq('sheet_index', sheetIndex).eq('part_number', partNumber).eq('status', 'queued').single()
  if (existing.error || !existing.data) throw new Error(existing.error?.message ?? 'The re-cut queue changed. Refresh and try again.')
  return existing.data
}

export async function listRunRecuts(ownerId: string, runId: string, signal: AbortSignal): Promise<MachineRecut[]> {
  const client = await clientFor(ownerId)
  const { data, error } = await client.from('cnc_machine_recuts').select(columns).eq('owner_id', ownerId).eq('source_run_id', runId).eq('status', 'queued').abortSignal(signal)
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function listMachineRecuts(ownerId: string, offset: number, status: RecutStatus | '', signal: AbortSignal): Promise<MachineRecut[]> {
  const client = await clientFor(ownerId)
  let query = client.from('cnc_machine_recuts').select(columns).eq('owner_id', ownerId).order('created_at', { ascending: true }).order('id').range(offset, offset + 24)
  if (status) query = query.eq('status', status)
  const { data, error } = await query.abortSignal(signal)
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function changeMachineRecutStatus(ownerId: string, entry: MachineRecut, status: Exclude<RecutStatus, 'queued'>): Promise<void> {
  const client = await clientFor(ownerId)
  const { data, error } = await client.from('cnc_machine_recuts').update({ status }).eq('owner_id', ownerId).eq('id', entry.id).eq('status', 'queued').select('id').single()
  if (error || !data) throw new Error(error?.message ?? 'This re-cut changed on another device. Refresh the queue before updating it.')
}
