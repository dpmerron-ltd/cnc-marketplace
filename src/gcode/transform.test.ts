import { describe, expect, it } from 'vitest'
import type { PartInstance } from '../models/PartInstance'
import { createPartFromGCode } from './importPart'
import { instanceBounds, transformPartProgram } from './transform'

function makePart(gcode: string) {
  return createPartFromGCode('test.nc', gcode)
}

function makeInstance(patch: Partial<PartInstance> = {}): PartInstance {
  return { id: 'i1', partId: 'p1', sheetIndex: 0, x: 100, y: 200, rotation: 0, locked: false, ...patch }
}

describe('G-code parser and coordinate transformer', () => {
  it('translates absolute linear X/Y coordinates', () => {
    const part = makePart('G21\nG90\nG01 X0 Y0\nG01 X10 Y20\nM30')
    const result = transformPartProgram(part, makeInstance())
    expect(result.lines).toContain('G01 X110 Y220')
  })

  it('rotates endpoints at 0, 90, 180 and 270 degrees around the normalized footprint', () => {
    const part = makePart('G21\nG90\nG01 X0 Y0\nG01 X10 Y20\nM30')
    expect(transformPartProgram(part, makeInstance({ rotation: 0 })).lines.at(-1)).toBe('G01 X110 Y220')
    expect(transformPartProgram(part, makeInstance({ rotation: 90 })).lines.at(-1)).toBe('G01 X100 Y210')
    expect(transformPartProgram(part, makeInstance({ rotation: 180 })).lines.at(-1)).toBe('G01 X100 Y200')
    expect(transformPartProgram(part, makeInstance({ rotation: 270 })).lines.at(-1)).toBe('G01 X120 Y200')
  })

  it('rotates arc endpoint and I/J vector together', () => {
    const part = makePart('G21\nG90\nG01 X0 Y0\nG02 X10 Y10 I5 J0\nM30')
    const result = transformPartProgram(part, makeInstance({ rotation: 90 }))
    expect(result.lines).toContain('G02 X100 Y210 I0 J5')
  })

  it('keeps I/J unchanged for pure translation', () => {
    const part = makePart('G21\nG90\nG01 X0 Y0\nG02 X10 Y10 I5 J0\nM30')
    const result = transformPartProgram(part, makeInstance())
    expect(result.lines).toContain('G02 X110 Y210 I5 J0')
  })

  it('reconstructs missing modal axes when rotation needs both coordinates', () => {
    const part = makePart('G21\nG90\nG01 X0 Y0\nG01 X10\nG01 Y20\nM30')
    const result = transformPartProgram(part, makeInstance({ rotation: 90 }))
    expect(result.lines).toContain('G01 X120 Y210')
    expect(result.lines).toContain('G01 X100 Y210')
    expect(result.warnings.some((warning) => warning.includes('emitted both X and Y'))).toBe(true)
  })

  it('leaves Z-only and feed-only commands spatially untouched', () => {
    const part = makePart('G21\nG90\nG01 X0 Y0\nG01 Z-6 F1200\nF900\nM30')
    const result = transformPartProgram(part, makeInstance({ rotation: 90 }))
    expect(result.lines).toContain('G01 Z-6 F1200')
    expect(result.lines).toContain('F900')
  })

  it('handles negative and decimal coordinates during normalization', () => {
    const part = makePart('G21\nG90\nG01 X-5.5 Y-2.25\nG01 X4.5 Y7.75\nM30')
    const result = transformPartProgram(part, makeInstance())
    expect(result.lines).toContain('G01 X100 Y200')
    expect(result.lines).toContain('G01 X110 Y210')
  })

  it('normalizes incremental XY moves to transformed absolute coordinates', () => {
    const part = makePart('G21\nG91\nG01 X10 Y20\nM30')
    const result = transformPartProgram(part, makeInstance({ rotation: 90 }))
    expect(result.errors).toEqual([])
    expect(result.lines).toContain('G01 X100 Y210')
  })

  it('computes transformed instance bounds', () => {
    const part = makePart('G21\nG90\nG01 X0 Y0\nG01 X10 Y20\nM30')
    const bounds = instanceBounds(part, makeInstance({ x: 5, y: 6, rotation: 90 }))
    expect(bounds).toEqual({ minX: 5, minY: 6, maxX: 25, maxY: 16 })
  })
})
