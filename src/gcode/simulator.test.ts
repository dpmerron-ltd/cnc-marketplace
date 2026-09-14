import { describe, expect, it } from 'vitest'
import { simulateGCode } from './simulator'

describe('G-code simulator', () => {
  it('estimates linear cutting and rapid time from emitted feed rates', () => {
    const simulation = simulateGCode(
      [
        'G21',
        'G90',
        'G00 Z5 F3000',
        'G00 X30 Y40 F3000',
        'G01 Z-5 F600',
        'G01 X90 Y40 F1200',
        'M30',
      ].join('\n'),
    )

    expect(simulation.errors).toEqual([])
    expect(simulation.deepestCutMm).toBe(5)
    expect(simulation.rapidDistanceMm).toBeCloseTo(55)
    expect(simulation.cuttingDistanceMm).toBeCloseTo(70)
    expect(simulation.estimatedSeconds).toBeCloseTo(5.1)
  })

  it('uses arc length for helical moves', () => {
    const simulation = simulateGCode('G21\nG90\nG00 X0 Y0\nG01 Z0 F600\nG02 X10 Y0 Z-1 I5 J0 F600\nM30')
    const arc = simulation.moves.find((move) => move.type === 'arc-cw')

    expect(simulation.errors).toEqual([])
    expect(arc?.lengthMm).toBeCloseTo(Math.hypot(Math.PI * 5, 1))
    expect(simulation.deepestCutMm).toBe(1)
  })

  it('reports arc radius mismatches', () => {
    const simulation = simulateGCode('G21\nG90\nG00 X0 Y0\nG02 X10 Y0 I4 J0\nM30')

    expect(simulation.errors.some((error) => error.includes('arc radius mismatch'))).toBe(true)
  })

  it('reports mid-program parking drops to Z0', () => {
    const simulation = simulateGCode('G21\nG90\nG01 X0 Y0\nG00 Z5\nG00 X10 Y10\nG00 Z0\nG01 X20 Y20\nM30')

    expect(simulation.errors.some((error) => error.includes('drops to Z0 before the end'))).toBe(true)
  })
})
