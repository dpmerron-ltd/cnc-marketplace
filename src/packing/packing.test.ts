import { describe, expect, it } from 'vitest'
import { estimatePacking, packingPieces } from './packing'
import type { PackingPiece } from './types'
import { createPartFromGCode } from '../gcode/importPart'

const piece = (id: string, width: number, height: number, thickness = 18): PackingPiece => ({ id, name: id, width, height, thickness, thicknessSource: 'entered', footprintSource: 'entered' })

describe('flat-pack box estimates', () => {
  it('packs one complete component with padding, carton walls and an internal size range', () => {
    const result = estimatePacking([piece('panel', 800, 300)])
    expect(result.errors).toEqual([])
    expect(result.plans[0].internal).toEqual({ length: 820, width: 320, height: 40 })
    expect(result.plans[0].external).toEqual({ length: 830, width: 330, height: 50 })
    expect(result.plans[0].rangeMax).toEqual({ length: 840, width: 340, height: 60 })
  })
  it('uses multiple layers and preserves every component exactly once without collisions', () => {
    const pieces = [piece('a', 970, 256), piece('b', 970, 232), piece('c', 260, 270), piece('d', 260, 270), piece('e', 480, 240, 12)]
    const result = estimatePacking(pieces)
    expect(result.errors).toEqual([])
    expect(result.candidates).toBeGreaterThan(1)
    for (const plan of result.plans) {
      expect(Math.max(...Object.values(plan.external))).toBeLessThanOrEqual(1200)
      expect(Math.max(...Object.values(plan.rangeMax)) + 10).toBeLessThanOrEqual(1200)
      expect(plan.layers.flatMap(layer => layer.parts.map(p => p.id)).sort()).toEqual(pieces.map(p => p.id).sort())
      let previousTop = 8
      for (const layer of plan.layers) {
        expect(layer.z).toBeGreaterThanOrEqual(previousTop + 2)
        previousTop = layer.z + layer.height
        for (const p of layer.parts) {
          const source = pieces.find(s => s.id === p.id)!
          expect([p.width, p.height]).toEqual(p.rotated ? [source.height, source.width] : [source.width, source.height])
          expect(p.x).toBeGreaterThanOrEqual(10)
          expect(p.y).toBeGreaterThanOrEqual(10)
          expect(p.x + p.width + 10).toBeLessThanOrEqual(plan.internal.length + 0.0001)
          expect(p.y + p.height + 10).toBeLessThanOrEqual(plan.internal.width + 0.0001)
          expect(source.thickness).toBeLessThanOrEqual(layer.height)
          for (const q of layer.parts.filter(q => q.id !== p.id)) expect(p.x + p.width + 2 <= q.x + 0.0001 || q.x + q.width + 2 <= p.x + 0.0001 || p.y + p.height + 2 <= q.y + 0.0001 || q.y + q.height + 2 <= p.y + 0.0001).toBe(true)
        }
      }
      expect(previousTop + 10).toBeLessThanOrEqual(plan.internal.height + 0.0001)
    }
    expect(result.plans.slice(1).every(plan => plan.volumeLitres >= result.plans[0].volumeLitres)).toBe(true)
  })
  it('can put small parts side-by-side instead of adding a full layer per part', () => {
    const result = estimatePacking([piece('base', 1000, 500), ...Array.from({ length: 4 }, (_, i) => piece(`small${i}`, 240, 240))])
    expect(result.plans[0].layers.length).toBeLessThan(5)
    expect(result.plans[0].layers.some(layer => layer.parts.length > 1)).toBe(true)
  })
  it('enforces the outer 1200 mm limit including rounding and padding', () => {
    const fits = estimatePacking([piece('limit', 1170, 300)])
    expect(fits.plans[0].external.length).toBe(1200)
    expect(fits.plans[0].rangeMax.length).toBe(1190)
    expect(estimatePacking([piece('too long', 1170.1, 300)]).plans).toEqual([])
    expect(estimatePacking([piece('too long', 1201, 300)], { paddingMm: 0, wallMm: 0 }).plans).toEqual([])
    expect(estimatePacking([piece('a', 1190, 300)], { paddingMm: 0, wallMm: 5 }).plans[0].external.length).toBe(1200)
  })
  it('rejects empty, invalid or excessive inputs without dropping components', () => {
    for (const values of [[], [piece('a', 0, 100)], [piece('a', NaN, 100)], [piece('a', 10, 10, -2)], [piece('a', 10, 10), piece('a', 10, 10)], Array.from({ length: 61 }, (_, i) => piece(String(i), 10, 10))]) {
      expect(estimatePacking(values).plans).toEqual([])
      expect(estimatePacking(values).errors.length).toBeGreaterThan(0)
    }
    expect(estimatePacking([piece('a', 100, 100)], { paddingMm: -1 }).errors.length).toBeGreaterThan(0)
  })
  it('uses material hints instead of confusing drill depth or overcut with stock thickness', () => {
    const part = createPartFromGCode('panel_12mm.nc', 'G21\nG90\nG00 Z20\nG00 X10 Y10\nG01 Z-4.5 F600\nG00 Z20\nM30')
    expect(packingPieces([part])[0]).toMatchObject({ thickness: 12, thicknessSource: 'material hint' })
    const noHint = { ...part, originalFilename: 'panel.nc' }
    expect(packingPieces([noHint])[0]).toMatchObject({ thickness: 18, thicknessSource: 'assumed' })
    const entered = packingPieces([noHint], { components: { [part.id]: { widthMm: 800, heightMm: 400, thicknessMm: 15 } } })[0]
    expect(entered).toMatchObject({ width: 800, height: 400, thickness: 15, thicknessSource: 'entered', footprintSource: 'entered' })
    expect(packingPieces([{ ...noHint, gcode: '(Material 12 mm / cutter 6.35 mm)\n' + part.gcode }])[0].thickness).toBe(12)
  })
})
