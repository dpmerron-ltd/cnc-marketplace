import { readDxf } from './dxf'
import { generateCam } from './generate'
import { recordedOperations } from './sourceOperations'
import { materialProfiles } from './materialProfiles'
import { parseGCode } from '../gcode/parser'
import { createPartFromGCode } from '../gcode/importPart'
import type { Part } from '../models/Part'
import { camPreset, type CamSettings } from './types'

export const noFinishingMarker = '(Finishing pass disabled: cut to size with zero allowance)'
// Compare machining words, allowing different controller startup/footer programs.
export function machiningSignature(code: string) {
  const start = code.indexOf('(No. 1 ')
  if (start < 0) return undefined
  const body = code.slice(start).split(/\nM0[25]\b/)[0]
  return JSON.stringify(parseGCode('G21\nG90\n' + body).bodyLines.filter(l => l.words.length).map(l => l.words.map(w => [w.letter, w.value])))
}
const cache = new WeakMap<Part, Map<string, Part>>()
export function withoutFinishing(part: Part, profileId?: string): Part {
  const cutter = part.gcode.match(/\(Material[^\n]*\/ cutter ([\d.]+) mm/i)?.[1]
  if (!cutter || Number(cutter) !== camPreset.diameter) throw new Error(`Skipping finishing requires saved machining for the ${camPreset.diameter} mm cutter. Regenerate from DXF.`)
  if (part.gcode.includes(noFinishingMarker)) return part
  const id = profileId ?? part.metadata.materialVariants?.primaryProfile
  const existing = cache.get(part)?.get(id ?? '')
  if (existing) return existing
  const profile = materialProfiles.find(p => p.id === id)
  if (!profile || !part.dxf) throw new Error('Skipping finishing requires a saved cutting preset and source DXF.')
  const drawing = readDxf(part.dxf, 'mm')
  const operations = recordedOperations(part.gcode, drawing)
  if (!operations) throw new Error('Cannot recover the saved machining operations. Regenerate from DXF before skipping finishing.')
  const settings: CamSettings = { thickness: profile.thickness, profilePasses: [12,13,14].includes(profile.thickness) ? profile.profilePasses : undefined, drillDepthMm: profile.drillDepthMm, rampProfile: profile.rampProfile, efficiencyTest: 'efficiencyTest' in profile, units: 'mm', operations }
  const signature = machiningSignature(part.gcode)
  let original = generateCam(drawing, settings)
  if (id === '12-2pass-2mm-depth12p4' && /\(Ramp 3 degrees F600 \/ cutting F3000 \//.test(part.gcode) && (original.errors.length || machiningSignature(original.gcode) !== signature)) {
    original = generateCam(drawing, settings, { legacyBreakthroughRamp: true })
  }
  if (!signature || original.errors.length || machiningSignature(original.gcode) !== signature) throw new Error('Saved machining could not be reproduced. Regenerate this component before skipping finishing.')
  // Regenerate from source using the current preset; never relabel saved coordinates.
  const next = generateCam(drawing, { ...settings, skipFinishingPass: true })
  if (next.errors.length) throw new Error(next.errors.join(' '))
  const result = { ...part, ...createPartFromGCode(part.originalFilename, next.gcode, part.dxf, part.itemId), id: part.id, name: part.name, sku: part.sku, ownerId: part.ownerId, dateImported: part.dateImported, cutSide: part.cutSide, stockMaterial: part.stockMaterial, metadata: { ...part.metadata, finishingPassSkipped: true } }
  let entries = cache.get(part)
  if (!entries) { entries = new Map(); cache.set(part, entries) }
  entries.set(id ?? '', result)
  return result
}
