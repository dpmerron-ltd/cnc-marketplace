import type { MarketplaceItem } from '../models/Item'
import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'
import type { ShopifyOrder } from './types'
import { selectMaterialParts } from '../gcode/materialSelection'
import { numberSheetParts } from '../labels/partLabels'

export type OrderItemMatches = Record<string, string>
export type NestProgress = { completed: number; total: number }
export type AddOrderRequest = { order: ShopifyOrder; shop: string; matches: OrderItemMatches }

export function matchOrderItems(order: ShopifyOrder, items: MarketplaceItem[], ownerId: string): OrderItemMatches {
  return Object.fromEntries(order.lineItems.nodes.map(line => {
    const matches = line.sku?.trim() ? items.filter(item => item.ownerId === ownerId && item.sku.trim().toUpperCase() === line.sku!.trim().toUpperCase()) : []
    return [line.id, matches.length === 1 ? matches[0].id : '']
  }))
}

export function prepareOrderSheet(request: AddOrderRequest, items: MarketplaceItem[], parts: Part[], sheet: Sheet, ownerId: string, sheetIndex: number) {
  const { order, shop, matches } = request
  if (order.lineItems.pageInfo.hasNextPage) throw new Error('Load all order items before adding this order.')
  const key = `${shop}/${order.id}`
  const ids = new Set(sheet.instances.map(instance => instance.id))
  if (sheet.orderImports?.some(entry => entry.key === key && entry.instanceIds.some(id => ids.has(id)))) throw new Error(`${order.name} is already on this sheet. Remove its existing components before adding it again.`)
  const additions: PartInstance[] = []
  for (const line of order.lineItems.nodes) {
    if (!Number.isSafeInteger(line.currentQuantity) || line.currentQuantity < 0) throw new Error(`${line.title}: invalid order quantity.`)
    if (!line.currentQuantity) continue
    const item = items.find(item => item.id === matches[line.id] && item.ownerId === ownerId)
    if (!item) throw new Error(`${line.title}: select an item from your catalogue.`)
    const components = parts.filter(part => part.ownerId === ownerId && part.itemId === item.id)
    if (!components.length) throw new Error(`${item.name} has no components.`)
    if (additions.length + components.length * line.currentQuantity > 500) throw new Error('This order exceeds 500 components. Split it into smaller cutting jobs.')
    for (let copy = 0; copy < line.currentQuantity; copy++) for (const part of components) additions.push({ id: crypto.randomUUID(), partId: part.id, sheetIndex: 0, x: sheet.borderSpacing, y: sheet.borderSpacing, rotation: 0, locked: false })
  }
  if (!additions.length) throw new Error('This order has no current items to add.')
  const selection = selectMaterialParts(parts.filter(part => part.ownerId === ownerId), { ...sheet, instances: [...sheet.instances, ...additions] })
  if (selection.errors.length) throw new Error(selection.errors.join(' '))
  const knownParts = new Set(selection.parts.map(part => part.id))
  if (sheet.instances.some(instance => !knownParts.has(instance.partId))) throw new Error('The sheet contains unavailable components. Reload your catalogue before adding this order.')
  const obstacles = sheet.instances.filter(instance => instance.sheetIndex >= sheetIndex).map(instance => ({ ...instance, sheetIndex: instance.sheetIndex - sheetIndex, locked: true }))
  return {
    parts: selection.parts,
    sheet: { ...sheet, instances: [...obstacles, ...additions] },
    count: additions.length,
    finish(instances: PartInstance[]): Sheet {
      const placed = instances.slice(obstacles.length).map(instance => ({ ...instance, sheetIndex: instance.sheetIndex + sheetIndex }))
      if (placed.length !== additions.length || placed.some((instance, i) => instance.id !== additions[i].id || instance.partId !== additions[i].partId)) throw new Error('Nesting returned an incomplete order. Your sheet is unchanged.')
      const orderNumbers = new Set((sheet.orderNumber ?? '').split(',').map(value => value.trim()).filter(Boolean))
      orderNumbers.add(order.name)
      return numberSheetParts({ ...sheet, orderNumber: [...orderNumbers].join(', '), instances: [...sheet.instances, ...placed], orderImports: [...(sheet.orderImports ?? []).filter(entry => entry.key !== key), { key, name: order.name, instanceIds: placed.map(instance => instance.id) }] })
    },
  }
}

export function nestOrder(parts: Part[], sheet: Sheet, signal: AbortSignal, onProgress: (progress: NestProgress) => void): Promise<PartInstance[]> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Adding order cancelled.')); return }
    const worker = new Worker(new URL('../nesting/worker.ts', import.meta.url), { type: 'module' })
    const finish = (error?: string, instances?: PartInstance[]) => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); worker.terminate()
      if (error) reject(new Error(error)); else resolve(instances!)
    }
    const cancel = () => finish('Adding order cancelled. Your sheet is unchanged.')
    const timer = setTimeout(() => finish('Nesting timed out after 30 seconds. Your sheet is unchanged.'), 30000)
    signal.addEventListener('abort', cancel, { once: true })
    worker.onmessage = (event: MessageEvent<{ progress?: NestProgress; error?: string; instances?: PartInstance[] }>) => {
      if (event.data.progress) onProgress(event.data.progress)
      else if (event.data.error) finish(event.data.error)
      else if (event.data.instances) finish(undefined, event.data.instances)
      else finish('Nesting returned no layout. Your sheet is unchanged.')
    }
    worker.onerror = () => finish('Nesting failed. Your sheet is unchanged.')
    worker.onmessageerror = () => finish('Nesting returned unreadable data. Your sheet is unchanged.')
    try {
      const ids = new Set(sheet.instances.map(instance => instance.partId))
      worker.postMessage({ parts: parts.filter(part => ids.has(part.id)), sheet })
    } catch (error) { finish(error instanceof Error ? error.message : 'Nesting failed.') }
  })
}
