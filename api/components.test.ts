// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { parseComponent } from './components'
import { testItem, testParts } from '../src/test/jobFixtures'
import { materialProfiles, materialVariantsSchema } from '../src/cam/materialProfiles'
import * as simulation from '../src/gcode/simulator'

const input = { id: '20000000-0000-4000-8000-000000000001', name: 'Side', sku: 'SIDE', filename: 'side.nc', gcode: testParts[0].gcode }
describe('component uploads', () => {
  it('reuses only identical server-stored variants while validating primary and changed NC', () => {
    const materialVariants = materialVariantsSchema.parse({ version: 1, primaryProfile: '18', profiles: Object.fromEntries(materialProfiles.map(profile => [profile.id, { gcode: input.gcode, errors: [], warnings: [] }])) })
    const simulate = vi.spyOn(simulation, 'simulateGCode')
    try {
      const result = parseComponent({ ...input, materialVariants }, 'alice', testItem.id, materialVariants)
      expect(result.part.metadata.materialVariants).toEqual(materialVariants)
      expect(simulate).toHaveBeenCalledTimes(1)
      const changed = structuredClone(materialVariants)
      changed.profiles['6'].gcode = input.gcode.replace('Z-2', 'Z-18.4')
      expect(() => parseComponent({ ...input, materialVariants: changed }, 'alice', testItem.id, materialVariants)).toThrow('6 mm variant cuts deeper')
      changed.profiles['6'].gcode = input.gcode.replace('G21', 'G20')
      expect(() => parseComponent({ ...input, materialVariants: changed }, 'alice', testItem.id, materialVariants)).toThrow('metric and absolute')
      expect(() => parseComponent({ ...input, materialVariants, gcode: 'G20\nG91\n' }, 'alice', testItem.id, materialVariants)).toThrow()
      expect(() => parseComponent({ ...input, materialVariants, storedVariants: materialVariants }, 'alice', testItem.id)).toThrow('Invalid component')
      simulate.mockClear()
      parseComponent({ ...input, materialVariants }, 'alice', testItem.id)
      expect(simulate.mock.calls.length).toBeGreaterThan(1)
    } finally { simulate.mockRestore() }
  })
  it('stores all validated material variants and rejects mismatches or unsafe alternate programs', () => {
    const materialVariants = materialVariantsSchema.parse({ version: 1, primaryProfile: '18', profiles: Object.fromEntries(materialProfiles.map(profile => [profile.id, { gcode: input.gcode, errors: [], warnings: [] }])) })
    const parsed = parseComponent({ ...input, materialVariants }, 'alice', testItem.id)
    expect(parsed.part.metadata.materialVariants).toEqual(materialVariants)
    expect(() => parseComponent({ ...input, gcode: input.gcode + '\n', materialVariants }, 'alice', testItem.id)).toThrow('must match')
    materialVariants.profiles['6'].gcode = input.gcode.replace('Z-2', 'Z-18.4')
    expect(() => parseComponent({ ...input, materialVariants }, 'alice', testItem.id)).toThrow('6 mm variant cuts deeper')
    materialVariants.profiles['6'] = { gcode: '', errors: ['Unsupported pocket depth'], warnings: [] }
    expect(parseComponent({ ...input, materialVariants }, 'alice', testItem.id).part.metadata.materialVariants?.profiles['6'].errors).toEqual(['Unsupported pocket depth'])
    materialVariants.profiles['12'].gcode = input.gcode.replace('G21', 'G20')
    expect(() => parseComponent({ ...input, materialVariants }, 'alice', testItem.id)).toThrow('metric and absolute')
  })
  it('preserves exact source programs and derives geometry rather than trusting dimensions', () => {
    const { part } = parseComponent({ ...input, dxf: 'original DXF' }, 'alice', testItem.id)
    expect(part).toMatchObject({ id: input.id, ownerId: 'alice', itemId: testItem.id, name: 'Side', sku: 'SIDE', width: 50, height: 50, gcode: input.gcode, dxf: 'original DXF' })
    expect(() => parseComponent({ ...input, width: 100 }, 'alice', testItem.id)).toThrow('Invalid component')
  })
  it('rejects invalid identities, excessive payloads and unsupported or malformed machining', () => {
    for (const patch of [{ id: 'part' }, { filename: '../side.nc' }, { ownerId: 'bob' }]) expect(() => parseComponent({ ...input, ...patch }, 'alice', testItem.id)).toThrow('Invalid component')
    expect(() => parseComponent({ ...input, gcode: 'x\n'.repeat(20001) }, 'alice', testItem.id)).toThrow('Component limit')
    expect(() => parseComponent({ ...input, gcode: input.gcode.replace('G21', 'G20') }, 'alice', testItem.id)).toThrow('metric and absolute')
    expect(() => parseComponent({ ...input, gcode: input.gcode.replace('G90', 'G91') }, 'alice', testItem.id)).toThrow('metric and absolute')
    expect(() => parseComponent({ ...input, gcode: 'G21\nG90\nG00 Z20\nG00 X0 Y0\nG01 Z-2 F600\nG02 X20 Y20\nG00 Z20\nM30' }, 'alice', testItem.id)).toThrow('failed machining validation')
  })
})

it('retains large bounded panel programs without dropping movements or validation', () => {
  const moves = Array.from({ length: 12000 }, (_, index) => `G01 X${index % 2 ? 20 : 10} Y10 Z-2 F600`).join('\n')
  const gcode = `G21\nG90\nG00 Z20\nG00 X10 Y10\nG01 Z-2 F600\n${moves}\nG00 Z20\nM30`
  const part = parseComponent({ ...input, gcode }, 'alice', testItem.id).part
  expect(part.gcode).toBe(gcode)
  expect(() => parseComponent({ ...input, gcode: gcode.replace('G21', 'G20') }, 'alice', testItem.id)).toThrow('metric and absolute')
  expect(() => parseComponent({ ...input, gcode: gcode + '\n'.repeat(20000) }, 'alice', testItem.id)).toThrow('Component limit')
})
