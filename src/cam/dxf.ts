import DxfParser from 'dxf-parser'
import type { IEntity } from 'dxf-parser/dist/entities/geomtry'
import type { Point } from '../models/geometry'
import type { CamDrawing, CamFeature } from './types'
import { arcPoints, area, contains, distance } from './geometry'

type Vertex = Point & { z?: number; bulge?: number; startWidth?: number; endWidth?: number }
type Entity = IEntity & { vertices?: Vertex[]; center?: Vertex; position?: Vertex; radius?: number; startAngle?: number; endAngle?: number; shape?: boolean; elevation?: number; width?: number; is3dPolyline?: boolean; is3dPolygonMesh?: boolean; isPolyfaceMesh?: boolean; includesCurveFitVertices?: boolean; includesSplineFitVertices?: boolean; extrusionDirection?: Vertex; extrusionDirectionX?: number; extrusionDirectionY?: number; extrusionDirectionZ?: number }
const supported = new Set(['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE', 'POLYLINE', 'POINT'])
const annotations = new Set(['TEXT', 'MTEXT', 'DIMENSION'])

function polyline(vertices: Vertex[], closed: boolean): Point[] {
  const result: Point[] = []
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length]
    result.push({ x: a.x, y: a.y })
    if ((!closed && i === vertices.length - 1) || !a.bulge) continue
    const chord = distance(a, b), bulge = a.bulge
    if (chord < 0.001) throw new Error('Zero-length bulged segment.')
    const center = { x: (a.x + b.x) / 2 - (b.y - a.y) * (1 - bulge * bulge) / (4 * bulge), y: (a.y + b.y) / 2 + (b.x - a.x) * (1 - bulge * bulge) / (4 * bulge) }
    const sampled = arcPoints(center, chord * (1 + bulge * bulge) / (4 * Math.abs(bulge)), Math.atan2(a.y - center.y, a.x - center.x), 4 * Math.atan(bulge))
    result.push(...sampled.slice(1, -1))
  }
  return result
}

export function readDxf(source: string): CamDrawing {
  if (source.length > 2000000) throw new Error('DXF exceeds 2 MB.')
  if (source.startsWith('AutoCAD Binary DXF')) throw new Error('Use an ASCII DXF export.')
  const warnings: string[] = [], errors: string[] = []
  // The library skips unknown entities. Audit DXF group pairs so no machining geometry disappears silently.
  const lines = source.replace(/\r/g, '').split('\n')
  let section = '', awaitingSection = false
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim()), value = lines[i + 1].trim()
    if (code === 0 && value === 'SECTION') awaitingSection = true
    else if (awaitingSection && code === 2) { section = value; awaitingSection = false }
    else if (code === 0 && value === 'ENDSEC') section = ''
    else if (section === 'ENTITIES' && code === 0 && !supported.has(value) && !annotations.has(value) && !['VERTEX', 'SEQEND'].includes(value)) errors.push(`Unsupported DXF entity ${value}. Convert it to 2D lines/arcs/polylines before importing.`)
  }
  const dxf = new DxfParser().parseSync(source)
  if (!dxf) throw new Error('DXF could not be read.')
  if (dxf.entities.length > 1000) throw new Error('DXF exceeds 1,000 entities. Split the drawing.')
  const unitCode = Number(dxf.header.$INSUNITS ?? 0)
  const units = unitCode === 4 ? 'mm' : unitCode === 1 ? 'inches' : 'unknown'
  if (unitCode && units === 'unknown') errors.push(`DXF unit code ${unitCode} is unsupported. Export in millimetres or inches.`)
  if (!unitCode) warnings.push('DXF units are unspecified. Confirm the drawing units and dimensions.')
  const features: CamFeature[] = []
  const chains: Array<{ points: Point[]; layer: string }> = []
  for (const [index, raw] of dxf.entities.entries()) {
    const e = raw as Entity, label = `${e.type} ${index + 1}`, layer = e.layer ?? '0'
    if (annotations.has(e.type)) { warnings.push(`${e.type} annotations are excluded.`); continue }
    if (!supported.has(e.type)) continue
    try {
      const vertices = e.vertices ?? []
      if (e.width || vertices.some(p => p.startWidth || p.endWidth || (p.bulge !== undefined && !Number.isFinite(p.bulge)))) throw new Error('Nonzero polyline widths or invalid bulges are unsupported.')
      const extrusion = e.extrusionDirection ?? { x: e.extrusionDirectionX ?? 0, y: e.extrusionDirectionY ?? 0, z: e.extrusionDirectionZ ?? 1 }
      if (e.inPaperSpace || e.is3dPolyline || e.is3dPolygonMesh || e.isPolyfaceMesh || e.includesCurveFitVertices || e.includesSplineFitVertices || Math.abs(e.elevation ?? 0) > 0.001 || Math.abs(extrusion.x) > 0.001 || Math.abs(extrusion.y) > 0.001 || extrusion.z !== 1 || [...vertices, ...(e.center ? [e.center] : []), ...(e.position ? [e.position] : [])].some(p => Math.abs(p.z ?? 0) > 0.001)) throw new Error('Only flat XY model-space geometry is supported.')
      let points: Point[] = [], closed = false
      let circle: CamFeature['circle']
      if (e.type === 'CIRCLE') {
        if (!e.center || !e.radius) throw new Error('Invalid circle.')
        circle = { center: { x: e.center.x, y: e.center.y }, radius: e.radius }
        points = arcPoints(e.center, e.radius, 0, Math.PI * 2).slice(0, -1); closed = true
      } else if (e.type === 'POINT') {
        if (!e.position) throw new Error('Invalid drill point.')
        points = [e.position]
      } else if (e.type === 'ARC') {
        if (!e.center || !e.radius || e.startAngle === undefined || e.endAngle === undefined) throw new Error('Invalid arc.')
        const sweep = ((e.endAngle - e.startAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
        if (!sweep) throw new Error('Zero-length arc.')
        points = arcPoints(e.center, e.radius, e.startAngle, sweep)
      } else {
        if (vertices.length < 2) throw new Error('Not enough vertices.')
        closed = Boolean(e.shape)
        points = polyline(vertices, closed)
      }
      if (points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 100000 || Math.abs(p.y) > 100000)) throw new Error('Invalid or excessive coordinates.')
      points = points.filter((p, i) => !i || distance(p, points[i - 1]) > 1e-7)
      if (points.length > 2 && distance(points[0], points.at(-1)!) < 0.01) { points.pop(); closed = true }
      if (!closed && points.length > 1) chains.push({ points, layer })
      else features.push({ id: `f${index}`, name: label, layer, points, closed, circle, kind: e.type === 'POINT' ? 'drill' : 'unassigned' })
    } catch (error) { errors.push(`${label}: ${(error as Error).message}`) }
  }
  while (chains.length) {
    const chain = chains.shift()!
    let closed = false
    while (!closed) {
      const matches = chains.flatMap((candidate, index) => candidate.layer !== chain.layer ? [] : [
        ...(distance(chain.points.at(-1)!, candidate.points[0]) < 0.01 ? [{ index, reverse: false }] : []),
        ...(distance(chain.points.at(-1)!, candidate.points.at(-1)!) < 0.01 ? [{ index, reverse: true }] : []),
      ])
      if (matches.length > 1) { errors.push(`Branched or duplicate geometry on layer ${chain.layer}.`); break }
      if (!matches.length) {
        chain.points.reverse()
        const canJoin = chains.some(c => c.layer === chain.layer && (distance(chain.points.at(-1)!, c.points[0]) < 0.01 || distance(chain.points.at(-1)!, c.points.at(-1)!) < 0.01))
        if (!canJoin) break
        continue
      }
      const match = matches[0], next = chains.splice(match.index, 1)[0].points
      if (match.reverse) next.reverse()
      chain.points.push(...next.slice(1))
      closed = distance(chain.points[0], chain.points.at(-1)!) < 0.01
      if (closed) chain.points.pop()
    }
    features.push({ id: `joined${features.length}`, name: `Contour ${features.length + 1}`, layer: chain.layer, points: chain.points, closed, kind: 'unassigned' })
  }
  if (features.reduce((sum, f) => sum + f.points.length, 0) > 25000 || features.length > 250) throw new Error('Drawing exceeds 250 operations or 25,000 curve points. Split the drawing.')
  for (const f of features) {
    if (f.kind === 'drill') continue
    if (!f.closed) { warnings.push(`${f.name} is open and needs to be closed or explicitly excluded.`); continue }
    const layer = f.layer.toUpperCase()
    if (f.circle && /POCKET/.test(layer)) { f.kind = 'pocket'; f.depthMm = Number(layer.match(/DEPTH[_ -]?(\d+(?:\.\d+)?)/)?.[1]) || undefined }
    else if (f.circle && /DRILL|BORE/.test(layer)) f.kind = 'drill'
    else if (f.circle && /INNER|INSIDE/.test(layer)) f.kind = 'pocket'
    else if (/DOOR|INNER|INSIDE/.test(layer)) f.kind = 'inside'
    else if (/OUTER|PROFILE|OUTSIDE/.test(layer)) f.kind = 'outside'
    else if (f.circle && f.circle.radius * 2 <= (units === 'inches' ? 0.25 : 6.35) + 0.001) f.kind = 'drill'
    else {
      const nesting = features.filter(other => other !== f && other.closed && Math.abs(area(other.points)) > Math.abs(area(f.points)) && contains(other.points, f.points[0])).length
      f.kind = nesting % 2 ? 'inside' : 'outside'
    }
  }
  if (!features.length) errors.push('No supported machining geometry found.')
  return { features, errors: [...new Set(errors)], warnings: [...new Set(warnings)], units }
}
