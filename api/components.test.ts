// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseComponent } from './components'
import { testItem, testParts } from '../src/test/jobFixtures'

const input = { id: '20000000-0000-4000-8000-000000000001', name: 'Side', sku: 'SIDE', filename: 'side.nc', gcode: testParts[0].gcode }
describe('component uploads', () => {
  it('preserves exact source programs and derives geometry rather than trusting dimensions', () => {
    const { part } = parseComponent({ ...input, dxf: 'original DXF' }, 'alice', testItem.id)
    expect(part).toMatchObject({ id: input.id, ownerId: 'alice', itemId: testItem.id, name: 'Side', sku: 'SIDE', width: 50, height: 50, gcode: input.gcode, dxf: 'original DXF' })
    expect(() => parseComponent({ ...input, width: 100 }, 'alice', testItem.id)).toThrow('Invalid component')
  })
  it('rejects invalid identities, excessive payloads and unsupported or malformed machining', () => {
    for (const patch of [{ id: 'part' }, { filename: '../side.nc' }, { ownerId: 'bob' }]) expect(() => parseComponent({ ...input, ...patch }, 'alice', testItem.id)).toThrow('Invalid component')
    expect(() => parseComponent({ ...input, gcode: 'x\n'.repeat(10001) }, 'alice', testItem.id)).toThrow('Component limit')
    expect(() => parseComponent({ ...input, gcode: input.gcode.replace('G21', 'G20') }, 'alice', testItem.id)).toThrow('metric and absolute')
    expect(() => parseComponent({ ...input, gcode: input.gcode.replace('G90', 'G91') }, 'alice', testItem.id)).toThrow('metric and absolute')
    expect(() => parseComponent({ ...input, gcode: 'G21\nG90\nG00 Z20\nG00 X0 Y0\nG01 Z-2 F600\nG02 X20 Y20\nG00 Z20\nM30' }, 'alice', testItem.id)).toThrow('failed machining validation')
  })
})
