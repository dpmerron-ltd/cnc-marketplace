import { sheetMaterial, stockLabel } from '../models/stockMaterial'
import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import { sheetCutSide } from '../models/cutSide'

export function sheetGCodeFilename(base: string, parts: Part[], sheet: Sheet, index?: number): string {
  const indices = index === undefined ? [...new Set(sheet.instances.map(i => i.sheetIndex))] : [index]
  const sides = new Set(indices.map(i => sheetCutSide(parts, sheet, i)).filter(side => side !== 'either'))
  const suffix = sides.size > 1 || sides.has('mixed') ? '-pattern-and-non-pattern-sides'
    : sides.has('pattern') ? '-pattern-side-up' : sides.has('non-pattern') ? '-non-pattern-side-up' : ''
  const stocks = [...new Set(indices.map(i => sheetMaterial(sheet, i).stockMaterial).filter(Boolean).map(stock => stockLabel(stock)))]
  const material = stocks.length > 1 ? '-mixed-materials' : stocks.length ? '-' + stocks[0].toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/-+$/,'') : ''
  return `${base}${material}${suffix}.nc`
}
