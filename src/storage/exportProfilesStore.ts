import { supabase } from './supabaseClient'
import { normalizePrograms, validatePrograms, type ProgramSettings } from '../gcode/programSettings'
export interface ExportProfile { key: 'andy' | 'dan'; label: string; isCurrent: boolean; programs: ProgramSettings }
export async function loadExportProfiles(ownerId: string): Promise<ExportProfile[]> {
  if (!supabase) throw new Error('Cloud connection is not configured.')
  const user = await supabase.auth.getUser()
  if (user.error || user.data.user?.id !== ownerId) throw new Error('The signed-in account changed.')
  const { data, error } = await supabase.rpc('load_cnc_export_profiles')
  if (error) throw new Error(error.message)
  if (!Array.isArray(data)) throw new Error('Machine profiles could not be loaded.')
  if (!data.length) return []
  if (data.length !== 2 || new Set(data.map(row => row.machine_key)).size !== 2 || data.some(row => !['andy', 'dan'].includes(row.machine_key)) || data.filter(row => row.is_current === true).length !== 1) throw new Error('Both Andy and Dan machine profiles are required.')
  return data.map(row => {
    const programs = normalizePrograms({ startGcode: row.start_gcode, spindleStartGcode: row.spindle_start_gcode, endGcode: row.end_gcode })
    const errors = validatePrograms(programs)
    if (errors.length) throw new Error(`${row.machine_key}: ${errors.join(' ')}`)
    return { key: row.machine_key, label: row.machine_key === 'andy' ? 'Andy' : 'Dan', isCurrent: row.is_current, programs }
  })
}
