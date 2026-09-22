import type { MarketplaceItem } from '../models/Item'
import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import { numberSheetParts } from '../labels/partLabels'
import { autoNest, partFitsSheet } from './nestingEngine'
import { selectMaterialParts } from '../gcode/materialSelection'

export function addItemToSheet(item: MarketplaceItem, parts: Part[], sheet: Sheet, ownerId: string, sheetIndex: number): Sheet {
  if (!ownerId) throw new Error('Sign in to use the shared catalogue.')
  const selection = selectMaterialParts(parts, { ...sheet, instances: [...sheet.instances, ...parts.filter(part => part.itemId === item.id).map(part => ({ partId: part.id }))] })
  if (selection.errors.length) throw new Error(selection.errors.join(' '))
  parts = selection.parts
  const components = parts.filter(part => part.itemId === item.id)
  if (!components.length) throw new Error('This item has no components.')
  const oversized = components.find(part => !partFitsSheet(part, sheet))
  if (oversized) throw new Error(`${oversized.name} does not fit this sheet. Increase the sheet size before adding this item.`)
  const additions = components.map(part => ({ id: crypto.randomUUID(), partId: part.id, sheetIndex: 0, x: sheet.borderSpacing, y: sheet.borderSpacing, rotation: 0 as const, locked: false }))
  // Treat existing placements as fixed obstacles. Nest additions from the active sheet onward.
  const obstacles = sheet.instances.filter(instance => instance.sheetIndex >= sheetIndex).map(instance => ({ ...instance, sheetIndex: instance.sheetIndex - sheetIndex, locked: true }))
  const nested = autoNest(parts, { ...sheet, instances: [...obstacles, ...additions] }).slice(obstacles.length).map(instance => ({ ...instance, sheetIndex: instance.sheetIndex + sheetIndex }))
  return numberSheetParts({ ...sheet, instances: [...sheet.instances, ...nested] })
}
