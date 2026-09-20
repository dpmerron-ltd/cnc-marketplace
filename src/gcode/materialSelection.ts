import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import { materialProfiles, type MaterialProfileId } from '../cam/materialProfiles'
import { createPartFromGCode } from './importPart'

const cache = new WeakMap<Part, Map<MaterialProfileId, { gcode: string; part: Part }>>()

export function selectMaterialParts(parts: Part[], sheet: Pick<Sheet, 'materialProfile'> & { instances: ReadonlyArray<{ partId: string }> }) {
  const errors: string[] = []
  if (sheet.materialProfile === undefined) return { parts, errors }
  const profile = materialProfiles.find(profile => profile.id === sheet.materialProfile)
  if (!profile) return { parts, errors: ['Unknown sheet material thickness. Select a supported thickness.'] }
  const placed = new Set(sheet.instances.map(instance => instance.partId))
  const selected = parts.map(part => {
    if (!placed.has(part.id)) return part
    const variant = part.metadata.materialVariants?.profiles[profile.id]
    if (!variant || variant.errors.length || !variant.gcode) {
      if (placed.has(part.id)) errors.push(`${part.name}: ${profile.label} G-code unavailable. ${variant?.errors.join(' ') || 'Regenerate this component from its DXF before exporting at this thickness.'}`)
      return part
    }
    if (part.gcode === variant.gcode) return part
    let entries = cache.get(part)
    if (!entries) { entries = new Map(); cache.set(part, entries) }
    const cached = entries.get(profile.id)
    if (cached?.gcode === variant.gcode) return cached.part
    const filename = `${part.originalFilename.replace(/(?:-(?:6|12|15|18)mm(?:-2pass)?)?\.[^.]+$/, '')}-${profile.thickness}mm${profile.id === '12-2pass' ? '-2pass' : ''}.nc`
    const generated = createPartFromGCode(filename, variant.gcode, part.dxf, part.itemId)
    const resolved: Part = { ...part, ...generated, id: part.id, ownerId: part.ownerId, name: part.name, sku: part.sku, dateImported: part.dateImported, metadata: { ...generated.metadata, materialVariants: part.metadata.materialVariants } }
    entries.set(profile.id, { gcode: variant.gcode, part: resolved })
    return resolved
  })
  return { parts: selected, errors }
}
