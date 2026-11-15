import ClipperLib from 'clipper-lib'
import type { Point, Bounds } from '../models/geometry'
import { rotatePointInBounds } from '../models/geometry'
import { camPreset, type CamFeature } from '../cam/types'
import { area, contains, fromClipper, intersectionArea, toClipper } from '../cam/geometry'
import { boundsPolygon, polygonBounds } from '../gcode/footprint'
import type { SharedSource } from './sharedCuts'

const close = (a: number, b: number) => Math.abs(a - b) < 0.0001
const clean = (x: number) => Number(x.toFixed(4))
export interface OrientedSource {
  source: SharedSource
  rotation: number
  features: CamFeature[]
  outer: Point[]
  width: number
  height: number
}
export interface EdgeLayout {
  key: string
  members: [OrientedSource, OrientedSource]
  offsets: [Point, Point]
  outline: Point[]
  anchors: Point[]
  slot: [Point, Point]
  length: number
  width: number
  height: number
}
interface Edge { a: Point; b: Point; length: number }
export function supportingEdges(points: Point[], side: 'left' | 'right' | 'top' | 'bottom'): Edge[] {
  const bounds = polygonBounds(points)
  const vertical = side === 'left' || side === 'right'
  const coordinate = vertical ? 'x' : 'y'
  const value = side === 'left' ? bounds.minX : side === 'right' ? bounds.maxX : side === 'bottom' ? bounds.minY : bounds.maxY
  return points.flatMap((a, i) => {
    const b = points[(i + 1) % points.length]
    return close(a[coordinate], value) && close(b[coordinate], value) ? [{ a, b, length: Math.hypot(b.x - a.x, b.y - a.y) }] : []
  }).filter(e => e.length > 0.001).sort((a,b) => b.length-a.length)
}
function orient(source: SharedSource, rotation: number): OrientedSource {
  const transform = (p: Point) => rotatePointInBounds({ x: p.x - source.bounds.minX, y: p.y - source.bounds.minY }, source, rotation)
  const features = source.features.map(f => ({ ...f, points: f.points.map(transform), circle: f.circle ? { ...f.circle, center: transform(f.circle.center) } : undefined }))
  const outer = features.find(f => f.kind === 'outside')!.points
  const bounds = polygonBounds(outer)
  return { source, rotation, features, outer, width: bounds.maxX, height: bounds.maxY }
}
function translate(p: Point, shift: Point): Point { return { x: p.x + shift.x, y: p.y + shift.y } }

// A tab must have an intact root inside its member, and face an unobstructed
// waste corridor outside the pair. Support-line tabs make that corridor explicit.
function tabAnchor(member: OrientedSource, side: 'left' | 'right' | 'top' | 'bottom'): Point | undefined {
  const half = (camPreset.tabWidth + camPreset.diameter) / 2
  const rim = camPreset.diameter
  const interiors = member.features.filter(f => f.kind !== 'outside')
  for (const edge of supportingEdges(member.outer, side)) {
    if (edge.length < half * 2 + camPreset.diameter * 2 + 0.01) continue
    for (const fraction of [0.5, 0.25, 0.75, 1/3, 2/3, 0.125, 0.375, 0.625, 0.875]) {
      if (Math.min(fraction, 1-fraction) * edge.length < half + camPreset.diameter + 0.005) continue
      const center = { x: edge.a.x + (edge.b.x-edge.a.x)*fraction, y: edge.a.y + (edge.b.y-edge.a.y)*fraction }
      const root: Bounds = side === 'left' ? { minX:center.x+0.01,maxX:center.x+rim,minY:center.y-half,maxY:center.y+half }
        : side === 'right' ? { minX:center.x-rim,maxX:center.x-0.01,minY:center.y-half,maxY:center.y+half }
        : side === 'bottom' ? { minX:center.x-half,maxX:center.x+half,minY:center.y+0.01,maxY:center.y+rim }
        : { minX:center.x-half,maxX:center.x+half,minY:center.y-rim,maxY:center.y-0.01 }
      const rootPath = boundsPolygon(root)
      if (Math.abs(area(rootPath)) - intersectionArea(rootPath, member.outer) > 0.001) continue
      // Include cutter/relief reach. Segment tests also cover narrow centreline
      // operations whose swept cut has area even when the source polyline does not.
      const reach = camPreset.diameter
      const exclusion = { minX:root.minX-reach, maxX:root.maxX+reach, minY:root.minY-reach, maxY:root.maxY+reach }
      if (interiors.some(f => f.circle ? Math.hypot(
        f.circle.center.x-Math.max(exclusion.minX,Math.min(exclusion.maxX,f.circle.center.x)),
        f.circle.center.y-Math.max(exclusion.minY,Math.min(exclusion.maxY,f.circle.center.y))) <= f.circle.radius
        : f.points.some((p,i)=>segmentHitsBounds(p,f.points[(i+1)%f.points.length],exclusion)) || contains(f.points,center))) continue
      return center
    }
  }
}
function segmentHitsBounds(a: Point, b: Point, bounds: Bounds): boolean {
  let low = 0, high = 1
  for (const [start, delta, min, max] of [[a.x,b.x-a.x,bounds.minX,bounds.maxX],[a.y,b.y-a.y,bounds.minY,bounds.maxY]]) {
    if (Math.abs(delta)<1e-9) { if(start<min || start>max) return false; continue }
    const from=(min-start)/delta,to=(max-start)/delta
    low=Math.max(low,Math.min(from,to));high=Math.min(high,Math.max(from,to))
    if(low>high) return false
  }
  return true
}
function union(paths: Point[][]): Point[] {
  const clip = new ClipperLib.Clipper()
  for (const points of paths) {
    const path = toClipper(points)
    if (!ClipperLib.Clipper.Orientation(path)) path.reverse()
    clip.AddPath(path, ClipperLib.PolyType.ptSubject, true)
  }
  const result: ClipperLib.Paths = []
  clip.Execute(ClipperLib.ClipType.ctUnion, result, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  if (result.length !== 1) throw new Error('The shared edge does not form a connected perimeter.')
  return fromClipper(result[0])
}
const cache = new WeakMap<SharedSource,WeakMap<SharedSource,EdgeLayout[]>>()
export function edgeLayouts(a: SharedSource,b: SharedSource): EdgeLayout[] {
  const cached=cache.get(a)?.get(b)
  if(cached) return cached
  const layouts: EdgeLayout[]=[]
  if(a.profile.id !== b.profile.id) return layouts
  const orientationsA=[0,90,180,270].map(r=>orient(a,r)),orientationsB=[0,90,180,270].map(r=>orient(b,r))
  const seen=new Set<string>()
  const leftAnchors = orientationsA.map(m=>(['left','bottom','top'] as const).map(side=>tabAnchor(m,side)))
  const rightAnchors = orientationsB.map(m=>(['right','bottom','top'] as const).map(side=>tabAnchor(m,side)))
  for(const [li,left] of orientationsA.entries()) for(const [ri,right] of orientationsB.entries()) {
    const anchorsLeft=leftAnchors[li],anchorsRight=rightAnchors[ri]
    if([...anchorsLeft,...anchorsRight].some(p=>!p)) continue
    for(const ea of supportingEdges(left.outer,'right')) for(const eb of supportingEdges(right.outer,'left')) {
      if(Math.min(ea.length,eb.length)<camPreset.diameter*6) continue
      const a0=Math.min(ea.a.y,ea.b.y),a1=Math.max(ea.a.y,ea.b.y),b0=Math.min(eb.a.y,eb.b.y),b1=Math.max(eb.a.y,eb.b.y)
      for(const dy of [a0-b0,a1-b1,(a0+a1-b0-b1)/2]) {
        const key=`edge:${left.rotation}:${right.rotation}:${clean(dy)}:${clean(Math.max(a0,b0+dy))}:${clean(Math.min(a1,b1+dy))}`
        if(seen.has(key)) continue
        seen.add(key)
        const low=Math.max(a0,b0+dy),high=Math.min(a1,b1+dy),length=high-low
        if(length<camPreset.diameter*6) continue
        const offsets: [Point,Point]=[{x:0,y:-Math.min(0,dy)},{x:left.width+camPreset.diameter,y:Math.max(0,dy)}]
        const pa=left.outer.map(p=>translate(p,offsets[0])),pb=right.outer.map(p=>translate(p,offsets[1]))
        const bridge=boundsPolygon({minX:left.width,maxX:offsets[1].x,minY:low+offsets[0].y,maxY:high+offsets[0].y})
        try {
          const outline=union([pa,pb,bridge])
          if(Math.abs(Math.abs(area(outline))-Math.abs(area(pa))-Math.abs(area(pb))-length*camPreset.diameter)>0.01) continue
          const bounds=polygonBounds(outline),x=left.width+camPreset.diameter/2
          layouts.push({key,members:[left,right],offsets,outline,anchors:[...anchorsLeft.map(p=>translate(p!,offsets[0])),...anchorsRight.map(p=>translate(p!,offsets[1]))],slot:[{x,y:low+offsets[0].y},{x,y:high+offsets[0].y}],length,width:bounds.maxX,height:bounds.maxY})
        } catch { /* A disconnected or ambiguous bridge cannot be shared. */ }
      }
    }
  }
  layouts.sort((a,b)=>b.length-a.length || a.width*a.height-b.width*b.height || a.key.localeCompare(b.key))
  let entries=cache.get(a);if(!entries){entries=new WeakMap();cache.set(a,entries)}entries.set(b,layouts)
  return layouts
}
export function layoutFeatures(layout: EdgeLayout): CamFeature[] {
  return layout.members.flatMap((member,i)=>member.features.filter(f=>f.kind!=='outside').map(f=>({
    ...f,id:`${i?'b':'a'}-${f.id}`,points:f.points.map(p=>translate(p,layout.offsets[i])),
    circle:f.circle?{...f.circle,center:translate(f.circle.center,layout.offsets[i])}:undefined,
  })))
}
