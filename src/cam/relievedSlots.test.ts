// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readDxf } from './dxf'
import { relievedRectangleGeometry, minimumOpeningWidth } from './rectangle'
import { defaultTabCount } from './types'
import { generateDxfNc } from '../../api/dxf'

// Synthetic mortises reproduce fit clearance and local reliefs without product DXFs.
const outline = [[2, 0], [78, 0], [81, -1], [81, 2], [80, 3], [80, 9.2], [81, 10.2], [81, 13.2], [78, 12.2], [2, 12.2], [-1, 13.2], [-1, 10.2], [0, 9.2], [0, 3], [-1, 2], [-1, -1]]
const polyline = (layer: string, points: number[][]) => [0, 'LWPOLYLINE', 8, layer, 90, points.length, 70, 1, ...points.flatMap(([x, y]) => [10, x, 20, y])]
const source = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES',
  ...polyline('CUT_OUTER', [[0, 0], [400, 0], [400, 600], [0, 600]]),
  ...Array.from({ length: 13 }, (_, i) => polyline('CUT_INNER_THROUGH', outline.map(([x, y]) => [x + 30, y + 30 + i * 40]))).flat(),
  ...Array.from({ length: 17 }, (_, i) => [0, 'CIRCLE', 8, 'DRILL', 10, 200, 20, 30 + i * 30, 40, 1]).flat(),
  0, 'ENDSEC', 0, 'EOF', ''].join('\n')
const drawing = readDxf(source)

describe('relieved 12 mm mortises', () => {
  it.each([0, 17, 45, 90, 135, 270])('measures straight walls instead of corner reliefs at %s degrees', degrees => {
    const a = degrees * Math.PI / 180
    const holes = drawing.features.filter(f => f.kind === 'inside')
    expect(holes).toHaveLength(13)
    for (const hole of holes) {
      for (const mirror of [1, -1]) {
        const points = hole.points.map(p => ({ x: mirror * p.x * Math.cos(a) - p.y * Math.sin(a), y: mirror * p.x * Math.sin(a) + p.y * Math.cos(a) })).reverse()
        points.push(points[0])
        expect(minimumOpeningWidth(points)).toBeGreaterThan(14)
        expect(relievedRectangleGeometry(points, 6.35)?.width).toBeCloseTo(12.2)
        expect(defaultTabCount({ ...hole, points })).toBe(0)
        expect(defaultTabCount({ ...hole, points, kind: 'outside' })).toBe(4)
        const larger = points.map(p => ({ x: p.x * 2, y: p.y * 2 }))
        expect(minimumOpeningWidth(larger)).toBeGreaterThan(28)
        expect(defaultTabCount({ ...hole, points: larger })).toBe(4)
      }
    }
  })
  it('does not mistake a narrow neck within a wider cutout for a relieved slot', () => {
    const hole = drawing.features.find(f => f.kind === 'inside')!
    const points = [...hole.points]
    points.splice(16, 0, { x: 250, y: 27 })
    expect(relievedRectangleGeometry(points, 6.35)).toBeUndefined()
    expect(defaultTabCount({ ...hole, points })).toBe(4)
  })
  it('exports every slot tab-free across all five profiles, retaining outer tabs and drills', async () => {
    const result = await generateDxfNc({ dxf: source, thicknessMm: 12, layerOperations: { CUT_INNER_THROUGH: { cornerOvercuts: false, tabs: 4 } } })
    expect(result.operations.filter(op => op.kind === 'inside')).toHaveLength(13)
    expect(result.operations.filter(op => op.kind === 'inside').every(op => op.tabCount === 0)).toBe(true)
    expect(result.operations.filter(op => op.kind === 'drill')).toHaveLength(17)
    expect(result.operations.filter(op => op.kind === 'drill').every(op => op.depthMm === 4.5)).toBe(true)
    expect(result.operations.find(op => op.kind === 'outside')?.tabCount).toBe(4)
    expect(result.warnings).toEqual([])
    for (const variant of Object.values(result.materialVariants.profiles)) {
      expect(variant.errors).toEqual([])
      const insideBlocks = variant.gcode.split(/(?=\(No\. \d+ )/).filter(block => /^\(No\. \d+ inside /.test(block))
      expect(insideBlocks).toHaveLength(13)
      expect(insideBlocks.every(block => !block.includes('(Tab '))).toBe(true)
    }
  })
})
