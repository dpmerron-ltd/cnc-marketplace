import { describe, expect, it } from 'vitest'
import { BoxGeometry, Mesh } from 'three'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'
import { parseStl } from './stl'

function box(binary = true) {
  const mesh = new Mesh(new BoxGeometry(20, 30, 40))
  mesh.position.set(100, -50, 20); mesh.updateMatrixWorld()
  const result = binary ? new STLExporter().parse(mesh, { binary: true }).buffer : new TextEncoder().encode(new STLExporter().parse(mesh)).buffer
  mesh.geometry.dispose()
  return result as ArrayBuffer
}
describe('STL parsing', () => {
  it.each([true, false])('reads %s binary/ascii with dimensions, finite normals and a centred preview', binary => {
    const parsed = parseStl(box(binary))
    expect(parsed.dimensions).toEqual([20, 30, 40])
    expect(parsed.triangles).toBe(12)
    expect(parsed.positions.length).toBe(108)
    expect([...parsed.normals].every(Number.isFinite)).toBe(true)
    expect(Math.min(...parsed.positions.filter((_, i) => i % 3 === 0))).toBe(-10)
  })
  it('accepts a binary file whose header starts with solid', () => {
    const buffer = box(); new Uint8Array(buffer).set(new TextEncoder().encode('solid binary file'))
    expect(parseStl(buffer).triangles).toBe(12)
  })
  it('rejects corrupt/truncated, non-finite and oversized meshes', () => {
    expect(() => parseStl(box().slice(0, 90))).toThrow(/complete/)
    expect(() => parseStl(new TextEncoder().encode('<html>not an STL</html>').buffer)).toThrow(/complete/)
    expect(() => parseStl(new ArrayBuffer(26 * 1024 * 1024))).toThrow(/25 MB/)
    const buffer = box(); new DataView(buffer).setFloat32(96, NaN, true)
    expect(() => parseStl(buffer)).toThrow(/coordinates/)
  })
  it('does not trust binary facet counts before allocating geometry', () => {
    const buffer = box(); new DataView(buffer).setUint32(80, 0xffffffff, true)
    expect(() => parseStl(buffer)).toThrow()
  })
  it('rejects incomplete ASCII triangles', () => {
    expect(() => parseStl(new TextEncoder().encode('solid part\nfacet normal 0 0 1\nvertex 0 0 0\nendsolid part').buffer)).toThrow(/invalid triangles/)
  })
})
