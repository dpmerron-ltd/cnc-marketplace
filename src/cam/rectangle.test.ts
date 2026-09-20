import { describe, expect, it } from 'vitest'
import { minimumOpeningWidth, rectangleGeometry } from './rectangle'
import { cutterWidthOpening, defaultTabCount, requiresHoldingTabs, type CamFeature } from './types'

function rectangle(width: number, length = 100, degrees = 0): CamFeature {
  const angle = degrees * Math.PI / 180
  return { id: 'slot', name: 'Slot', layer: 'INSIDE', kind: 'inside', closed: true, points: [[0, 0], [length, 0], [length, width], [0, width]].map(([x, y]) => ({ x: 20 + x * Math.cos(angle) - y * Math.sin(angle), y: 30 + x * Math.sin(angle) + y * Math.cos(angle) })) }
}

describe('Cutter-width rectangular holes', () => {
  it.each([0, 30, 45, 90, 180, 270])('uses the narrowest actual side, including %s degree rotation', degrees => {
    const feature = rectangle(6.35, 100, degrees)
    expect(rectangleGeometry(feature.points)?.width).toBeCloseTo(6.35)
    expect(cutterWidthOpening(feature)).toBeDefined()
    expect(defaultTabCount(feature)).toBe(0)
    expect(requiresHoldingTabs(feature)).toBe(false)
  })
  it.each([0.5, 3, 6, 6.35])('defaults %s mm narrow rectangular/square holes to zero tabs', width => {
    for (const length of [width, 100]) expect(defaultTabCount(rectangle(width, length))).toBe(0)
  })
  it('preserves wider hole and outer profile defaults, including doors', () => {
    expect(defaultTabCount(rectangle(6.351))).toBe(0)
    expect(defaultTabCount(rectangle(12))).toBe(0)
    expect(defaultTabCount(rectangle(12.001))).toBe(4)
    expect(defaultTabCount({ ...rectangle(6.35), kind: 'outside' })).toBe(4)
    expect(requiresHoldingTabs({ ...rectangle(6.35), kind: 'outside' })).toBe(true)
    expect(requiresHoldingTabs({ ...rectangle(100, 300), door: true })).toBe(true)
    expect(defaultTabCount({ ...rectangle(6.35), layer: 'DOOR' })).toBe(0)
    expect(cutterWidthOpening({ ...rectangle(6.35), kind: 'pocket' })).toBeUndefined()
    expect(cutterWidthOpening({ ...rectangle(6.35), closed: false })).toBeUndefined()
    expect(cutterWidthOpening(rectangle(6), 5)).toBeUndefined()
  })
  it.each([0, 17, 45, 90, 137, 270])('measures the 12 mm cutoff at %s degrees, including non-rectangular openings', degrees => {
    const feature = rectangle(12, 200, degrees)
    expect(minimumOpeningWidth(feature.points)).toBeCloseTo(12)
    expect(defaultTabCount(feature)).toBe(0)
    expect(defaultTabCount({ ...feature, door: true })).toBe(0)
    feature.points.splice(1, 1)
    expect(minimumOpeningWidth(feature.points)).toBeLessThanOrEqual(12.000001)
    expect(defaultTabCount(feature)).toBe(0)
    expect(defaultTabCount(rectangle(12.001, 200, degrees))).toBe(4)
  })
  it('accepts reversed winding, repeated closing vertices and collinear DXF edges', () => {
    const feature = rectangle(6.35)
    feature.points.splice(1, 0, { x: 70, y: 30 })
    feature.points.push(feature.points[0])
    expect(cutterWidthOpening(feature)).toBeDefined()
    feature.points.reverse()
    expect(cutterWidthOpening(feature)).toBeDefined()
  })
  it('does not treat trapezoids, concave shapes or circular geometry as rectangles', () => {
    const feature = rectangle(6)
    feature.points[2].x -= 10
    expect(cutterWidthOpening(feature)).toBeUndefined()
    expect(cutterWidthOpening({ ...rectangle(6), circle: { center: { x: 0, y: 0 }, radius: 3 } })).toBeUndefined()
    expect(rectangleGeometry([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }])).toBeUndefined()
    expect(rectangleGeometry([])).toBeUndefined()
  })
})
