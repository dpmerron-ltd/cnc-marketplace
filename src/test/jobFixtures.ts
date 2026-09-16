import { createPartFromGCode } from '../gcode/importPart'
import type { MarketplaceItem } from '../models/Item'

export const testItem: MarketplaceItem = { id: '10000000-0000-4000-8000-000000000001', sku: 'LOCKER', name: 'Camperlocker', description: '', createdAt: '', updatedAt: '' }
export const testParts = ['left', 'right'].map((name, i) => ({ ...createPartFromGCode(`${name}.nc`, 'G21\nG17\nG90\nG00 X0 Y0 Z5\nG01 Z-2 F300\nG01 X50 Y0 F1000\nG01 X50 Y50\nG01 X0 Y50\nG01 X0 Y0\nG00 Z5\nM30', undefined, testItem.id), id: `part-${i}`, sku: `SIDE-${i}` }))
export const testRequest = { jobName: 'Camperlocker', orderNumber: 'ORDER-42', items: [{ sku: 'LOCKER', quantity: 2 }], sheet: { widthMm: 160, heightMm: 100, material: '18 mm plywood', thicknessMm: 18 } }
