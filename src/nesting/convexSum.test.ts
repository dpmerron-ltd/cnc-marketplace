import { describe, expect, it } from 'vitest'
import { convexHull } from '../gcode/footprint'
import { convexSum } from './convexSum'

describe('convex no-fit geometry', () => {
  it('matches the exhaustive vertex-pair hull for translated, rotated, reversed and degenerate inputs', () => {
    let seed = 42
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
    for (let i = 0; i < 60; i++) {
      const a = convexHull(Array.from({ length: i % 11 + 1 }, () => ({ x: Math.round(random() * 1000) - 500, y: Math.round(random() * 1000) - 500 })))
      const b = convexHull(Array.from({ length: i % 17 + 1 }, () => ({ x: Math.round(random() * 1000), y: Math.round(random() * 1000) }))).reverse()
      expect(convexSum(a, b)).toEqual(convexHull(a.flatMap(p => b.map(q => ({ x: p.x + q.x, y: p.y + q.y })))))
    }
  })

  it('bounds output size for dense curved envelopes without constructing their cartesian product', () => {
    const a = Array.from({ length: 2000 }, (_, i) => ({ x: 500 * Math.cos(i * Math.PI / 1000), y: 300 * Math.sin(i * Math.PI / 1000) }))
    const b = a.map(p => ({ x: -p.x, y: -p.y }))
    const sum = convexSum(a, b)
    expect(sum.length).toBeLessThanOrEqual(a.length + b.length)
    expect(Math.min(...sum.map(p => p.x))).toBeCloseTo(-1000, 6)
    expect(Math.max(...sum.map(p => p.y))).toBeCloseTo(600, 6)
  })
})
