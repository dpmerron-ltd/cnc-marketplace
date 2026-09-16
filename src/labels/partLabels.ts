import type { MarketplaceItem } from '../models/Item'
import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'

const validNumber = (value: number | undefined): value is number => Number.isSafeInteger(value) && value! > 0

export function numberSheetParts(sheet: Sheet): Sheet {
  let next = Math.max(1, validNumber(sheet.nextPartNumber) ? sheet.nextPartNumber : 1, ...sheet.instances.map(instance => validNumber(instance.partNumber) ? instance.partNumber + 1 : 1))
  const used = new Set<number>()
  const instances = sheet.instances.map(instance => {
    const partNumber = validNumber(instance.partNumber) && !used.has(instance.partNumber) ? instance.partNumber : next++
    used.add(partNumber)
    return { ...instance, partNumber }
  })
  return { ...sheet, instances, nextPartNumber: next }
}

export function partNumberText(value: number): string {
  return `P${String(value).padStart(3, '0')}`
}

export interface PartLabel {
  instanceId: string
  partNumber: string
  component: string
  item: string
  sku: string
  job: string
  order: string
  material: string
  sheetNumber: number
  cutOrder: number
  totalParts: number
  x: number
  y: number
  rotation: number
}

export function buildPartLabels(parts: Part[], items: MarketplaceItem[], input: Sheet): PartLabel[] {
  const sheet = numberSheetParts(input)
  const ordered = [...sheet.instances].sort((a, b) => a.sheetIndex - b.sheetIndex)
  return ordered.map((instance, index) => {
    const part = parts.find(candidate => candidate.id === instance.partId)
    if (!part) throw new Error('A placed component is missing. Restore or remove it before downloading labels.')
    return {
      instanceId: instance.id, partNumber: partNumberText(instance.partNumber!),
      component: part.name, item: items.find(item => item.id === part.itemId)?.name ?? '', sku: part.sku,
      job: sheet.name.trim() || 'Untitled Job', order: sheet.orderNumber?.trim() || '-', material: sheet.material?.trim() || '',
      sheetNumber: instance.sheetIndex + 1, cutOrder: index + 1, totalParts: ordered.length,
      x: instance.x, y: instance.y, rotation: instance.rotation,
    }
  })
}

export interface LabelLayout {
  width: number
  height: number
  format: 'single' | 'a4'
}

export function labelPageLayout(layout: LabelLayout) {
  if (![layout.width, layout.height].every(Number.isFinite) || layout.width < 40 || layout.height < 20 || layout.width > 190 || layout.height > 277) {
    throw new Error('Label size must be 40-190 mm wide and 20-277 mm high.')
  }
  const columns = layout.format === 'single' ? 1 : Math.floor(192 / (layout.width + 2))
  const rows = layout.format === 'single' ? 1 : Math.floor(279 / (layout.height + 2))
  return { columns, rows, perPage: columns * rows, pageWidth: layout.format === 'single' ? layout.width : 210, pageHeight: layout.format === 'single' ? layout.height : 297, margin: layout.format === 'single' ? 0 : 10 }
}
