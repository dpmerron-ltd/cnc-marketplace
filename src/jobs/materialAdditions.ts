import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'
import { materialProfiles } from '../cam/materialProfiles'
import { materialSetupKey, requiredMaterial, sheetMaterial, stockKey, type SheetMaterial } from '../models/stockMaterial'
import { allocateMaterials } from '../nesting/allocateMaterials'
import { today } from './production'

/** Plan all additions before changing any jobs. Existing layouts remain fixed. */
export function separateMaterialAdditions(parts: Part[], sheet: Sheet, additions: PartInstance[], index: number) {
  const current = sheetMaterial(sheet, index)
  const groups = new Map<string, { setup: SheetMaterial; additions: PartInstance[] }>()
  const matching: PartInstance[] = []
  for (const addition of additions) {
    const part = parts.find(p => p.id === addition.partId)
    if (!part) throw new Error('A component is unavailable. Reload before adding parts.')
    const stock = requiredMaterial(part)
    const primary = part.metadata.materialVariants?.primaryProfile
    let setup = addition.materialSetup ?? current
    if (!addition.materialSetup) {
      if (stock && stockKey(stock) !== stockKey(current.stockMaterial)) {
        const available = materialProfiles.filter(p => p.thickness === stock.thicknessMm && part.metadata.materialVariants?.profiles[p.id]?.gcode)
        setup = { stockMaterial: stock, material: `${stock.type} · ${stock.finish}`, materialProfile: available.find(p => p.id === primary)?.id ?? available[0]?.id }
        if (part.metadata.materialVariants && !setup.materialProfile) throw new Error(`${part.name}: no cutting preset is available for the required stock.`)
      } else if (!stock && primary && primary !== current.materialProfile) {
        setup = { materialProfile: primary, material: current.material }
      }
    }
    if (materialSetupKey(setup) === materialSetupKey(current)) matching.push(addition)
    else {
      const key = materialSetupKey(setup)
      if (!groups.has(key)) groups.set(key, { setup, additions: [] })
      groups.get(key)!.additions.push({ ...addition, materialSetup: setup })
    }
  }
  if (!groups.size) return undefined
  const newSheets = [...groups.values()].map(group => {
    const target: Sheet = { ...sheet, ...group.setup, stockMaterial: group.setup.stockMaterial, materialProfile: group.setup.materialProfile, material: group.setup.material, name: today(), instances: [], pendingParts: [], sheetMaterials: undefined,
      orderNumber: undefined, orderImports: undefined, nextPartNumber: undefined, unavailableSheetIndices: undefined }
    return allocateMaterials(parts, target, group.additions.map(i => ({ ...i, sheetIndex: 0, x: target.borderSpacing, y: target.borderSpacing })), 0)
  })
  return { newSheets, current: matching.length ? allocateMaterials(parts, sheet, matching, index) : undefined }
}
