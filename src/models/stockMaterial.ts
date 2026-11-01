import { z } from 'zod'
import type { Part } from './Part'
import type { Sheet } from './Sheet'
import type { PartInstance } from './PartInstance'
import type { MaterialProfileId } from '../cam/materialProfiles'

export const stockMaterialSchema = z.strictObject({
  thicknessMm: z.number().finite().positive().max(100),
  type: z.string().trim().min(1).max(80),
  finish: z.string().trim().min(1).max(80),
})
export type StockMaterial = z.infer<typeof stockMaterialSchema>
export interface SheetMaterial { stockMaterial?: StockMaterial; materialProfile?: MaterialProfileId; material?: string }
const normal = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')
export function stockKey(stock?: StockMaterial): string {
  return stock ? JSON.stringify([stock.thicknessMm, normal(stock.type), normal(stock.finish)]) : ''
}
export function stockLabel(stock?: StockMaterial): string {
  return stock ? `${stock.thicknessMm} mm ${stock.type} · ${stock.finish}` : 'Stock not specified'
}
export function requiredMaterial(part: Pick<Part, 'stockMaterial' | 'defaultStockMaterial'>): StockMaterial | undefined {
  return part.stockMaterial ?? part.defaultStockMaterial
}
export function defaultSheetMaterial(sheet: Sheet): SheetMaterial {
  return { stockMaterial: sheet.stockMaterial, materialProfile: sheet.materialProfile, material: sheet.material }
}
export function sheetMaterial(sheet: Sheet, index: number): SheetMaterial {
  return sheet.instances.find(i => i.sheetIndex === index)?.materialSetup ?? sheet.sheetMaterials?.[index] ?? defaultSheetMaterial(sheet)
}
export function materialSetupKey(setup: SheetMaterial): string {
  return JSON.stringify([stockKey(setup.stockMaterial), setup.materialProfile ?? '', setup.stockMaterial ? '' : normal(setup.material ?? '')])
}
export function physicalSheet(sheet: Sheet, index: number): Sheet {
  return { ...sheet, ...sheetMaterial(sheet, index), sheetMaterials: undefined, instances: sheet.instances.filter(i => i.sheetIndex === index) }
}
export function setSheetMaterial(sheet: Sheet, index: number, setup: SheetMaterial): Sheet {
  if (setup.stockMaterial) stockMaterialSchema.parse(setup.stockMaterial)
  return { ...sheet, sheetMaterials: { ...sheet.sheetMaterials, [index]: setup }, instances: sheet.instances.map(i => ({ ...i, materialSetup: i.sheetIndex === index ? setup : i.materialSetup ?? sheetMaterial(sheet, i.sheetIndex) })) }
}
export function snapshotMaterials(sheet: Sheet): PartInstance[] {
  return sheet.instances.map(i => ({ ...i, materialSetup: i.materialSetup ?? sheetMaterial(sheet, i.sheetIndex) }))
}
export function stockErrors(parts: Pick<Part, 'id' | 'name' | 'stockMaterial' | 'defaultStockMaterial'>[], sheet: Sheet): string[] {
  const errors = new Set<string>()
  for (const i of sheet.instances) {
    const part = parts.find(p => p.id === i.partId)
    const setup = sheetMaterial(sheet, i.sheetIndex)
    if (i.materialSetup && materialSetupKey(i.materialSetup) !== materialSetupKey(setup)) errors.add(`Sheet ${i.sheetIndex + 1} mixes stock, finishes or cutting presets. Allocate its parts to matching sheets.`)
    if (setup.stockMaterial && !stockMaterialSchema.safeParse(setup.stockMaterial).success) errors.add(`Sheet ${i.sheetIndex + 1} has invalid stock details.`)
    const required = part && requiredMaterial(part)
    if (required && stockKey(required) !== stockKey(setup.stockMaterial)) errors.add(`${part.name} requires ${stockLabel(required)}. Sheet ${i.sheetIndex + 1} uses ${stockLabel(setup.stockMaterial)}.`)
  }
  return [...errors]
}

export function hasSheetMaterials(sheet: Sheet): boolean {
  return Boolean(sheet.stockMaterial || Object.keys(sheet.sheetMaterials ?? {}).length || sheet.instances.some(i => i.materialSetup))
}
