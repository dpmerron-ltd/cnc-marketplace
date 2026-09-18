import { normalizePrograms, validatePrograms, type ProgramSettings } from '../gcode/programSettings'
import { supabase } from './supabaseClient'

async function clientFor(ownerId: string) {
  if (!supabase) throw new Error('Cloud connection is not configured.')
  const { data, error } = await supabase.auth.getUser()
  if (error || data.user?.id !== ownerId) throw new Error('The signed-in account changed. Reload before saving.')
  return supabase
}

export async function loadProgramSettings(ownerId: string): Promise<ProgramSettings | undefined> {
  const client = await clientFor(ownerId)
  const { data, error } = await client.from('user_program_settings').select('owner_id,start_gcode,spindle_start_gcode,end_gcode').eq('owner_id', ownerId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return undefined
  if (data.owner_id !== ownerId) throw new Error('Program settings belong to another account.')
  return normalizePrograms({ startGcode: data.start_gcode, spindleStartGcode: data.spindle_start_gcode, endGcode: data.end_gcode })
}

export async function saveProgramSettings(ownerId: string, value: ProgramSettings): Promise<ProgramSettings> {
  const programs = normalizePrograms(value)
  const errors = validatePrograms(programs)
  if (errors.length) throw new Error(errors.join('\n'))
  const client = await clientFor(ownerId)
  const { data, error } = await client.from('user_program_settings').upsert({ owner_id: ownerId, start_gcode: programs.startGcode, spindle_start_gcode: programs.spindleStartGcode, end_gcode: programs.endGcode, updated_at: new Date().toISOString() }).select('owner_id').single()
  if (error || data?.owner_id !== ownerId) throw new Error(error?.message ?? 'Program settings were not saved.')
  return programs
}
