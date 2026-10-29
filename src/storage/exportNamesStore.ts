import { supabase } from './supabaseClient'

export async function reserveExportName(id: string, ownerId: string): Promise<string> {
  if (!supabase) throw new Error('Cloud connection is required to allocate a job number.')
  const { data, error } = await supabase.rpc('reserve_cnc_job_name', { p_id: id, p_owner: ownerId })
  if (error || typeof data !== 'string') throw new Error(error?.message ?? 'The job number could not be allocated.')
  return data
}
