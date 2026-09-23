import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import type { Point } from '../models/geometry'
import { buildTabMap, type TabMap } from '../printing/tabMap'
import { selectMaterialParts } from '../gcode/materialSelection'
import { effectiveSafeZ } from '../gcode/safeZ'
import { preparationBounds } from '../gcode/preparationBounds'
import { planScrewPositions } from '../gcode/screwPositions'
import { materialProfiles } from '../cam/materialProfiles'

export type MachineStatus = 'waiting' | 'cutting' | 'completed' | 'cancelled'
export const machineStatusNames: Record<MachineStatus, string> = { waiting: 'Waiting to cut', cutting: 'Cutting', completed: 'Completed', cancelled: 'Cancelled' }
export interface MachineFile { filename: string; gcode: string; sha256: string; estimatedSeconds: number }
export interface ExportSnapshot {
  version: 1
  mode: 'combined' | 'sheets'
  map: TabMap
  material: string
  thickness: string
  safeZ: number
  deepestCutMm?: number
  warnings: string[]
  programs: Sheet['gcodeSettings']
  files: MachineFile[]
  sheets: Array<{ index: number; maxX: number; maxY: number; screws: Point[] }>
}
export interface MachineRunSummary {
  id: string; owner_id: string; name: string; order_number: string
  material: string; thickness: string; sheet_count: number; part_count: number
  status: MachineStatus; created_at: string
}
export interface MachineRun extends MachineRunSummary { snapshot: ExportSnapshot }

export async function ncHash(gcode: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(gcode))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function buildExportSnapshot(input: {
  mode: ExportSnapshot['mode']; parts: Part[]; sheet: Sheet
  files: Array<{ filename: string; gcode: string; simulation: { estimatedSeconds: number } }>
  summary: { deepestCutMm?: number; exportWarnings: string[] }
}): Promise<ExportSnapshot> {
  // Detach before the first await: later editor changes must never alter a saved export.
  const sheet = structuredClone(input.sheet)
  const map = buildTabMap(input.parts, sheet)
  const selected = selectMaterialParts(input.parts, sheet)
  if (selected.errors.length) throw new Error(selected.errors.join(' '))
  const safeZ = effectiveSafeZ(sheet)
  const preparedSheet = { ...sheet, gcodeSettings: { ...sheet.gcodeSettings, safeZ } }
  const sheets = Array.from({ length: map.sheetCount }, (_, index) => {
    const bounds = sheet.instances.filter(instance => instance.sheetIndex === index).map(instance => {
      const part = selected.parts.find(part => part.id === instance.partId)!
      const result = preparationBounds(part, instance, safeZ)
      if (result.errors.length) throw new Error(result.errors.join(' '))
      return result.bounds
    })
    const screws = planScrewPositions(selected.parts, preparedSheet, index)
    if (screws.errors.length) throw new Error(screws.errors.join(' '))
    return { index, maxX: Math.max(0, ...bounds.map(bound => bound.maxX)), maxY: Math.max(0, ...bounds.map(bound => bound.maxY)), screws: screws.points }
  })
  if (input.files.length !== (input.mode === 'combined' ? 1 : map.sheetCount)) throw new Error('Export file count does not match the sheet layout.')
  const files: MachineFile[] = []
  for (const file of input.files) files.push({ filename: file.filename, gcode: file.gcode, sha256: await ncHash(file.gcode), estimatedSeconds: file.simulation.estimatedSeconds })
  return {
    version: 1, mode: input.mode, map, sheets, files, safeZ,
    material: sheet.material?.trim() || 'Not specified',
    thickness: materialProfiles.find(profile => profile.id === sheet.materialProfile)?.label ?? 'Original NC - verify stock thickness',
    deepestCutMm: input.summary.deepestCutMm, warnings: [...input.summary.exportWarnings], programs: sheet.gcodeSettings,
  }
}
