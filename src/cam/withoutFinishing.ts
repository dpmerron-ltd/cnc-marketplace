import { readDxf } from './dxf'
import { generateCam } from './generate'
import { recordedOperations } from './sourceOperations'
import { materialProfiles } from './materialProfiles'
import { parseGCode } from '../gcode/parser'
import { createPartFromGCode } from '../gcode/importPart'
import type { Part } from '../models/Part'
import type { CamSettings } from './types'

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
  const original = generateCam(drawing, settings)
  if (original.errors.length || machiningSignature(original.gcode) !== machiningSignature(part.gcode)) throw new Error('Saved machining could not be reproduced. Regenerate this component before skipping finishing.')
  const next = generateCam(drawing, { ...settings, skipFinishingPass: true })
  if (next.errors.length) throw new Error(next.errors.join(' '))
  const result = { ...part, ...createPartFromGCode(part.originalFilename, next.gcode, part.dxf, part.itemId), id: part.id, name: part.name, sku: part.sku, ownerId: part.ownerId, dateImported: part.dateImported, cutSide: part.cutSide, stockMaterial: part.stockMaterial, metadata: { ...part.metadata, finishingPassSkipped: true } }
  let entries = cache.get(part)
  if (!entries) { entries = new Map(); cache.set(part, entries) }
  entries.set(id ?? '', result)
  return result
}
