import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'
import { compatibleCutSides, effectiveCutSide, sheetCutSide } from '../models/cutSide'
import { materialProfiles } from '../cam/materialProfiles'
import { selectMaterialParts } from '../gcode/materialSelection'
import { autoNest, partFitsSheet } from './nestingEngine'
import { numberSheetParts } from '../labels/partLabels'
import { materialSetupKey, requiredMaterial, sheetMaterial, snapshotMaterials, stockKey, stockLabel, type SheetMaterial } from '../models/stockMaterial'

export function allocateMaterials(parts: Part[], sheet: Sheet, additions: PartInstance[], startIndex = 0, matchingOnly = false): Sheet {
  if (sheet.instances.some(i => !parts.some(p => p.id === i.partId))) throw new Error('Load all existing sheet components before allocating more parts.')
  const next: Sheet = { ...sheet, instances: snapshotMaterials(sheet), pendingParts: [...(sheet.pendingParts ?? [])] }
  const closed = new Set(sheet.unavailableSheetIndices ?? [])
  for (const addition of additions) {
    const part = parts.find(p => p.id === addition.partId)
    if (!part) throw new Error('A component is unavailable. Reload before allocating parts.')
    const required = requiredMaterial(part)
    const original = addition.materialSetup
    const compatible = (index: number) => {
      if (closed.has(index)) return false
      const setup = sheetMaterial(next, index), face = sheetCutSide(parts, next, index)
      if (selectMaterialParts([part], { ...setup, instances: [{ partId: part.id }] }).errors.length) return false
      return (!required || stockKey(required) === stockKey(setup.stockMaterial)) && (!original || materialSetupKey(original) === materialSetupKey(setup)) && face !== 'mixed' && compatibleCutSides(face, effectiveCutSide(part, next))
    }
    const indices = [...new Set([startIndex, ...next.instances.map(i => i.sheetIndex), ...Object.keys(next.sheetMaterials ?? {}).map(Number)])]
    let index = (matchingOnly ? [startIndex] : indices).find(compatible)
    if (matchingOnly && index === undefined) { next.pendingParts!.push(addition); continue }
    let setup: SheetMaterial
    if (index !== undefined) setup = sheetMaterial(next, index)
    else {
      index = 0
      while (closed.has(index) || next.instances.some(i => i.sheetIndex === index) || (index === startIndex && sheetMaterial(next,index).stockMaterial)) index++
      const preferred = sheetMaterial(next, startIndex)
      const stock = original?.stockMaterial ?? required ?? preferred.stockMaterial
      let profile = original?.materialProfile
      if (!original) {
        const available = (id: string | undefined) => id && part.metadata.materialVariants?.profiles[id as keyof typeof part.metadata.materialVariants.profiles]?.gcode
        profile = stockKey(stock) === stockKey(preferred.stockMaterial) && available(preferred.materialProfile) ? preferred.materialProfile
          : materialProfiles.find(p => p.thickness === stock?.thicknessMm && available(p.id))?.id
        if (stock && !profile && part.metadata.materialVariants) throw new Error(`${part.name}: no cutting preset is available for ${stockLabel(stock)}. Generate a compatible program before adding this item.`)
      }
      setup = original ?? { stockMaterial: stock, materialProfile: profile, material: stock ? `${stock.type} · ${stock.finish}` : preferred.material }
    }
    const placed = { ...addition, sheetIndex: index!, materialSetup: setup }
    const selection = selectMaterialParts(parts, { ...next, ...setup, instances: [placed] })
    if (selection.errors.length) throw new Error(selection.errors.join(' '))
    if (!partFitsSheet(selection.parts.find(p => p.id === part.id)!, next)) throw new Error(`${part.name} does not fit the sheet. No parts were added.`)
    next.instances.push(placed)
  }
  // Existing waiting placements remain fixed while new parts fill their free space.
  const existing = new Map(sheet.instances.map(i => [i.id, i.locked]))
  const nested = autoNest(parts, { ...next, instances: next.instances.map(i => existing.has(i.id) ? { ...i, locked: true } : i) })
  next.instances = nested.map(i => existing.has(i.id) ? { ...i, locked: existing.get(i.id)! } : i)
  return numberSheetParts(next)
}
