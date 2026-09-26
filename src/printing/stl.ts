import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { maxStlBytes, maxStlTriangles, type ParsedStl } from './types'

export function parseStl(buffer: ArrayBuffer): ParsedStl {
  if (!buffer.byteLength || buffer.byteLength > maxStlBytes) throw new Error('Choose an STL file up to 25 MB.')
  const faces = buffer.byteLength >= 84 ? new DataView(buffer).getUint32(80, true) : 0
  const binary = buffer.byteLength === 84 + faces * 50
  if (binary) {
    if (!faces || faces > maxStlTriangles) throw new Error('STL must contain 1 to 500,000 triangles.')
  } else {
    const text = new TextDecoder().decode(buffer)
    if (!/^\s*solid\b/i.test(text) || !/endsolid[^\r\n]*\s*$/i.test(text)) throw new Error('This is not a complete binary or ASCII STL file.')
    const count = (text.match(/\bfacet\s+normal\b/gi) ?? []).length
    if (!count || count > maxStlTriangles || (text.match(/\bvertex\s/gi) ?? []).length !== count * 3) throw new Error('STL has invalid triangles or exceeds 500,000 triangles.')
  }
  const geometry = new STLLoader().parse(buffer)
  try {
    const position = geometry.getAttribute('position')
    if (!position || !position.count || position.count % 3 || position.count / 3 > maxStlTriangles) throw new Error('No valid triangular mesh in this STL.')
    for (const n of position.array) if (!Number.isFinite(n) || Math.abs(n) > 1e7) throw new Error('STL contains invalid or excessive coordinates.')
    geometry.computeBoundingBox()
    const bounds = geometry.boundingBox!
    const dimensions: [number, number, number] = [bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z]
    if (Math.max(...dimensions) <= 0) throw new Error('STL has no measurable geometry.')
    geometry.center()
    geometry.computeVertexNormals()
    if (!(geometry.getAttribute('normal').array as Float32Array).some(n => Math.abs(n) > 1e-8)) throw new Error('STL contains only zero-area triangles.')
    return { positions: position.array as Float32Array, normals: geometry.getAttribute('normal').array as Float32Array, dimensions, triangles: position.count / 3 }
  } finally { geometry.dispose() }
}
