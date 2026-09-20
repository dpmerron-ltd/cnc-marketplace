import { describe, expect, it } from 'vitest'
import { estimateStockPacking } from './stockPacking'
import type { PackingPiece, PackingEstimate } from './types'
import type { BoxStock } from './boxStock'

const piece = (id: string, width: number, height: number, thickness = 12): PackingPiece => ({ id, name: id, width, height, thickness, thicknessSource: 'entered', footprintSource: 'entered' })
const boxes: BoxStock[] = [1050, 1200].map((length, i) => ({ id: String(i), name: String(length), length_mm: length, width_mm: 350, height_mm: 400, quantity: 10, version: 1, details: '', updated_at: '' }))
function verify(result: PackingEstimate, pieces: PackingPiece[]) {
  expect(result.errors).toEqual([])
  expect(result.boxes.flatMap(b => b.layers.flatMap(l => l.parts.map(p => p.id))).sort()).toEqual(pieces.map(p => p.id).sort())
  for (const box of [...result.boxes, ...(result.suggestedBox ? [result.suggestedBox] : [])]) {
    let lastTop = -Infinity
    for (const layer of box.layers) {
      expect(layer.z).toBeGreaterThanOrEqual(result.settings.paddingMm)
      expect(layer.z).toBeGreaterThanOrEqual(lastTop + result.settings.separatorMm - 1e-7)
      lastTop = layer.z + layer.height
      expect(lastTop).toBeLessThanOrEqual(box.internal.height - result.settings.paddingMm + 1e-7)
      for (const p of layer.parts) {
        const source = pieces.find(s => s.id === p.id)!
        expect([p.width, p.height].sort((a, b) => a - b)).toEqual([source.width, source.height].sort((a, b) => a - b))
        expect(layer.height).toBeGreaterThanOrEqual(source.thickness)
        expect(p.x).toBeGreaterThanOrEqual(result.settings.paddingMm)
        expect(p.y).toBeGreaterThanOrEqual(result.settings.paddingMm)
        expect(p.x + p.width).toBeLessThanOrEqual(box.internal.length - result.settings.paddingMm + 1e-7)
        expect(p.y + p.height).toBeLessThanOrEqual(box.internal.width - result.settings.paddingMm + 1e-7)
        for (const q of layer.parts) if (p.id !== q.id) expect(p.x + p.width + result.settings.separatorMm <= q.x + 1e-7 || q.x + q.width + result.settings.separatorMm <= p.x + 1e-7 || p.y + p.height + result.settings.separatorMm <= q.y + 1e-7 || q.y + q.height + result.settings.separatorMm <= p.y + 1e-7).toBe(true)
      }
    }
  }
}
describe('Stock carton packing', () => {
  it('uses one stocked carton for a twelve-piece kit rather than a five-piece limit', () => {
    const pieces = Array.from({ length: 12 }, (_, i) => piece(String(i), 1000, 300))
    const result = estimateStockPacking(pieces, {}, boxes)
    verify(result, pieces)
    expect(result.boxes).toHaveLength(1)
    expect(result.boxes[0].stockId).toBe('0')
    expect(result.boxes[0].layers).toHaveLength(12)
  })
  it('uses spare layer space and handles mixed thickness without overlaps', () => {
    const pieces = [piece('a', 500, 300, 18), piece('b', 500, 300, 12), piece('c', 500, 300, 15)]
    const result = estimateStockPacking(pieces, {}, boxes)
    verify(result, pieces)
    expect(result.boxes[0].layers).toHaveLength(2)
    expect(result.boxes[0].layers.some(l => l.parts.length === 2)).toBe(true)
  })
  it('uses the exact internal limit and can turn cartons onto their side', () => {
    for (const pieces of [[piece('long', 1180, 300)], [piece('wide', 1000, 375)]]) {
      const result = estimateStockPacking(pieces, {}, boxes)
      verify(result, pieces)
      expect(result.boxes).toHaveLength(1)
      expect(result.boxes[0].stockId).toBeDefined()
    }
    const result = estimateStockPacking([piece('too-long', 1181, 300)], {}, boxes)
    expect(result.boxes).toHaveLength(0)
    expect(result.errors.length).toBeGreaterThan(0)
  })
  it('splits into two stock boxes only when a single tested layout cannot fit', () => {
    const pieces = Array.from({ length: 6 }, (_, i) => piece(String(i), 1000, 300, 100))
    const result = estimateStockPacking(pieces, {}, boxes)
    verify(result, pieces)
    expect(result.boxes).toHaveLength(2)
    expect(result.boxes.every(b => b.stockId)).toBe(true)
  })
  it('suggests new sizes for wider components and does not fake inventory availability', () => {
    const pieces = [piece('wide', 1000, 500)]
    const result = estimateStockPacking(pieces, {}, boxes)
    verify(result, pieces)
    expect(result.boxes[0].stockId).toBeUndefined()
    expect(result.suggestedBox?.internal).toEqual({ length: 1020, width: 520, height: 40 })
    const noStock = estimateStockPacking([piece('a', 1000, 300)], {}, boxes.map(b => ({ ...b, quantity: 0 })))
    expect(noStock.warnings.some(w => w.includes('Replenish 1'))).toBe(true)
  })
  it('rejects invalid inputs and remains bounded on a sixty-piece kit', () => {
    expect(estimateStockPacking([piece('a', NaN, 30)], {}, boxes).errors.length).toBeGreaterThan(0)
    const pieces = Array.from({ length: 60 }, (_, i) => piece(String(i), 200 + i % 5 * 10, 100, 6 + i % 3 * 6))
    const result = estimateStockPacking(pieces, {}, boxes)
    verify(result, pieces)
    expect(result.candidates).toBeLessThan(200)
  })
})
