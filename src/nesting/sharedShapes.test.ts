import { sharedSlotWidth } from './sharedGeometry'
import { describe, expect, it } from 'vitest'
import { generateCam } from '../cam/generate'
import { readDxf } from '../cam/dxf'
import { camPreset } from '../cam/types'
import { area, intersectionArea, contains, arcPoints } from '../cam/geometry'
import { createPartFromGCode } from '../gcode/importPart'
import { defaultProgramSettings } from '../gcode/programSettings'
import { exportCombinedGCode, exportPhysicalSheetGCodes } from '../gcode/exporter'
import { simulateGCode } from '../gcode/simulator'
import { validateSheet } from '../gcode/validator'
import { buildTabMap } from '../printing/tabMap'
import type { Part } from '../models/Part'
import type { Point } from '../models/geometry'
import type { Sheet } from '../models/Sheet'
import { boundsPolygon } from '../gcode/footprint'
import { autoNest } from './nestingEngine'
import { edgeLayouts } from './sharedGeometry'
import { generatePair, pairMemberInstances, planSharedCuts, sharedSource } from './sharedCuts'

const profile = '12-4pass-2mm-ramp20-5deg'
// A rounded/notched panel with long support edges and a rectangular mortise.
const outline: Point[] = [{x:0,y:0},{x:180,y:0},{x:180,y:40},{x:160,y:40},{x:160,y:60},{x:180,y:60},{x:180,y:250},{x:140,y:300},...arcPoints({x:30,y:270},30,Math.PI/2,Math.PI/2)]
function part(id: string, points=outline, holes: boolean | Point[][]=true): Part {
  const poly=(layer:string,points:Point[])=>[0,'LWPOLYLINE',8,layer,90,points.length,70,1,...points.flatMap(p=>[10,p.x,20,p.y])]
  const dxf=[0,'SECTION',2,'HEADER',9,'$INSUNITS',70,4,0,'ENDSEC',0,'SECTION',2,'ENTITIES',...poly('PROFILE',points),...(Array.isArray(holes)?holes.flatMap(p=>poly('INSIDE',p)):holes?poly('INSIDE',boundsPolygon({minX:40,minY:70,maxX:70,maxY:120})):[]),0,'ENDSEC',0,'EOF',''].join('\n')
  const result=generateCam(readDxf(dxf,'mm'),{thickness:12,profilePasses:4,drillDepthMm:2,rampProfile:'20mm-s-5deg',units:'mm',operations:{},programs:defaultProgramSettings})
  expect(result.errors).toEqual([])
  const source=createPartFromGCode(id+'.nc',result.gcode,dxf)
  return {...source,id,name:id,metadata:{...source.metadata,materialVariants:{version:1,primaryProfile:profile,profiles:{[profile]:{gcode:source.gcode,errors:[],warnings:[]}}} as never}}
}
function sheet(parts: Part[]): Sheet {
  return {name:'Shaped pairs',width:1220,height:1220,borderSpacing:13,spacing:16,nestingMethod:'v2',screwMarkingEnabled:false,gcodeSettings:{...defaultProgramSettings,safeZ:20},instances:parts.map((p,i)=>({id:'i'+i,partId:p.id,partNumber:i+1,x:13,y:13,rotation:0,locked:false,sheetIndex:0}))}
}

describe('sharing straight sections of shaped outlines',()=>{
  it('preserves notches and holes, shares a partial edge, and retains three outside tabs per member',()=>{
    const parts=[part('a'),part('b')],s=sheet(parts)
    const a=sharedSource(parts[0],s)!,b=sharedSource(parts[1],s)!
    expect(a.rectangle).toBe(false)
    const layouts=edgeLayouts(a,b)
    expect(layouts.length).toBeGreaterThan(0)
    for(const layout of layouts){
      const polygons=layout.members.map((m,i)=>m.outer.map(p=>({x:p.x+layout.offsets[i].x,y:p.y+layout.offsets[i].y})))
      expect(intersectionArea(polygons[0],polygons[1])).toBe(0)
      expect(Math.abs(area(layout.outline))).toBeCloseTo(Math.abs(area(polygons[0]))+Math.abs(area(polygons[1]))+layout.length*sharedSlotWidth,2)
      for(const polygon of polygons) expect(intersectionArea(layout.outline,polygon)).toBeCloseTo(Math.abs(area(polygon)),2)
      expect(layout.anchors).toHaveLength(6)
    }
    s.instances=autoNest(parts,s)
    const plan=planSharedCuts(parts,s)
    expect(plan.errors).toEqual([]);expect(plan.pairs).toHaveLength(1)
    expect(s.instances.every(i=>i.sharedEdgeLayoutKey?.startsWith('edge:'))).toBe(true)
    expect(validateSheet(parts,s).filter(i=>i.level==='error')).toEqual([])
    const cam=plan.pairs[0].cam,output=exportCombinedGCode(parts,s)
    expect(output.errors).toEqual([])
    expect(output.gcode.match(/Shared edge depth/g)).toHaveLength(4)
    expect(output.gcode.match(/Shared edge finishing /g)).toHaveLength(2)
    expect(output.gcode).toContain('inside machining')
    expect(cam.savedCutMm).toBeGreaterThan(0)
    expect(simulateGCode(output.gcode).deepestCutMm).toBe(12.4)
    const moves=simulateGCode(cam.part.gcode).moves
    for(const tab of cam.tabs){
      const cuts=moves.filter(m=>{
        if(m.type==='rapid')return false
        const dx=m.end.x-m.start.x,dy=m.end.y-m.start.y,sq=dx*dx+dy*dy
        const t=Math.max(0,Math.min(1,((tab.center.x-m.start.x)*dx+(tab.center.y-m.start.y)*dy)/(sq||1)))
        return Math.hypot(tab.center.x-m.start.x-t*dx,tab.center.y-m.start.y-t*dy)<camPreset.diameter/2-0.01
      })
      expect(cuts.length).toBeGreaterThan(0)
      expect(cuts.every(m=>Math.min(m.start.z,m.end.z)>=tab.z-0.001)).toBe(true)
    }
    const map=buildTabMap(parts,s)
    expect(map.parts.every(p=>p.tabs.filter(t=>t.operation==='V2 retained tab').length>=3)).toBe(true)
    expect(exportPhysicalSheetGCodes(parts,s)[0].errors).toEqual([])
    expect(exportCombinedGCode(parts,JSON.parse(JSON.stringify(s))).gcode).toBe(output.gcode)
    const tampered={...s,instances:s.instances.map((i,n)=>n?{...i,sharedEdgeLayoutKey:'edge:tampered'}:i)}
    expect(exportCombinedGCode(parts,tampered).errors.length).toBeGreaterThan(0)
  })
  it.each([0,90,180,270])('revalidates independent member rotations inside a pair rotated %s degrees',rotation=>{
    const parts=[part('a'),part('b')],s=sheet(parts),sources=parts.map(p=>sharedSource(p,s)!)
    const layout=edgeLayouts(sources[0],sources[1]).find(l=>l.members[0].rotation!==l.members[1].rotation)!
    expect(layout).toBeDefined()
    const cam=generatePair(sources[0],sources[1],layout.key)
    s.instances=pairMemberInstances(cam,{...s.instances[0],x:100,y:100,rotation},[s.instances[0],s.instances[1]],[sources[0],sources[1]])
    expect(planSharedCuts(parts,s).errors).toEqual([])
    expect(exportCombinedGCode(parts,s).errors).toEqual([])
    expect(buildTabMap(parts,s).parts.every(p=>p.tabs.length>=3)).toBe(true)
    const locked={...s,instances:s.instances.map(i=>({...i,locked:true}))}
    expect(autoNest(parts,locked)).toEqual(locked.instances)
    const separated=autoNest(parts,{...s,nestingMethod:'v1'})
    expect(separated.every(i=>!i.sharedEdgePartnerId&&!i.sharedEdgeLayoutKey)).toBe(true)
  })
  it('does not match recessed notches or parts that cannot support tabs on three other sides',()=>{
    const parts=[part('a',outline,false),part('thin',outline.map(p=>({x:p.x,y:p.y/12})),false)],s=sheet(parts)
    expect(edgeLayouts(sharedSource(parts[0],s)!,sharedSource(parts[1],s)!)).toEqual([])
    expect(autoNest(parts,s).every(i=>!i.sharedEdgePartnerId)).toBe(true)
    const normal=[part('one'),part('two')],current=sheet(normal),source=sharedSource(normal[0],current)!
    for(const layout of edgeLayouts(source,source)){
      const left=layout.members[0],right=layout.members[1],x=layout.slot[0].x
      expect(left.outer.every(p=>p.x+layout.offsets[0].x<=x-camPreset.diameter/2+0.001)).toBe(true)
      expect(right.outer.every(p=>p.x+layout.offsets[1].x>=x+camPreset.diameter/2-0.001)).toBe(true)
      for(let member=0;member<2;member++) for(const anchor of layout.anchors.slice(member*3,member*3+3)) expect(contains(layout.outline,anchor)).toBe(true)
    }
  })
  it('places tabs between nearby mortises instead of rejecting the entire shaped part',()=>{
    const holes=[45,90,135].map(x=>boundsPolygon({minX:x-5,maxX:x+5,minY:8,maxY:20}))
    const parts=[part('mortised-a',outline,holes),part('mortised-b',outline,holes)],s=sheet(parts)
    const source=sharedSource(parts[0],s)!
    const layout=edgeLayouts(source,source).find(l=>l.members[0].rotation===0)!
    expect(layout).toBeDefined()
    const bottom=layout.anchors.find(p=>Math.abs(p.y-layout.offsets[0].y)<0.001 && p.x<layout.slot[0].x)!
    expect(bottom).toBeDefined()
    for(const x of [45,90,135]) expect(Math.abs(bottom.x-x)).toBeGreaterThan(19)
    s.instances=autoNest(parts,s)
    expect(planSharedCuts(parts,s).pairs).toHaveLength(1)
    expect(exportCombinedGCode(parts,s).errors).toEqual([])
  })
  it('does not reinterpret a diagonally oriented rectangle as its bounding box',()=>{
    const points=[{x:100,y:0},{x:200,y:100},{x:100,y:200},{x:0,y:100}]
    const parts=[part('diamond-a',points,false),part('diamond-b',points,false)],s=sheet(parts)
    const a=sharedSource(parts[0],s),b=sharedSource(parts[1],s)
    expect(a?.rectangle).not.toBe(true)
    if(a&&b) expect(edgeLayouts(a,b)).toEqual([])
    expect(autoNest(parts,s).every(i=>!i.sharedEdgePartnerId)).toBe(true)
  })
  it('packs multiple shaped pairs in separate rectangular envelopes with connected waste corridors',()=>{
    const parts=Array.from({length:8},(_,i)=>part('part'+i)),s=sheet(parts)
    s.instances=autoNest(parts,s)
    const plan=planSharedCuts(parts,s)
    expect(plan.pairs).toHaveLength(4)
    expect(plan.errors).toEqual([])
    expect(validateSheet(parts,s).filter(i=>i.level==='error')).toEqual([])
  })
})
