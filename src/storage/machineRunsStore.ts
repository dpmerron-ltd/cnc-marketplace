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
  const { error } = await client.from('cnc_machine_runs').upsert({
    id, owner_id: ownerId, name: snapshot.map.name, order_number: snapshot.map.order,
    material: snapshot.material, thickness: snapshot.thickness,
    sheet_count: snapshot.map.sheetCount, part_count: snapshot.map.parts.length, snapshot,
  }, { onConflict: 'id', ignoreDuplicates: true })
  if (error) throw new Error(error.message)
  // A retry after a lost response keeps the same ID and cannot overwrite an export.
  const { data, error: readError } = await client.from('cnc_machine_runs').select('id').eq('owner_id', ownerId).eq('id', id).single()
  if (readError || data?.id !== id) throw new Error(readError?.message ?? 'The exported sheet was not saved.')
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
  if (data.snapshot?.version !== 1) throw new Error('Unsupported export snapshot. Reload the app.')
  return data
}

export async function changeMachineRunStatus(ownerId: string, run: MachineRun, status: MachineStatus): Promise<void> {
  const client = await clientFor(ownerId)
  const { data, error } = await client.from('cnc_machine_runs').update({ status }).eq('owner_id', ownerId).eq('id', run.id).eq('status', run.status).select('id').single()
  if (error || !data) throw new Error(error?.message ?? 'This export changed on another device. Refresh before updating it.')
}
