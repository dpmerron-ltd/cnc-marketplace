import { describe, expect, it } from 'vitest'
import { generateCam } from '../cam/generate'
import { readDxf } from '../cam/dxf'
import { createPartFromGCode } from '../gcode/importPart'
import { defaultProgramSettings } from '../gcode/programSettings'
import { exportCombinedGCode, exportPhysicalSheetGCodes } from '../gcode/exporter'
import { validateSheet } from '../gcode/validator'
import { simulateGCode } from '../gcode/simulator'
import { autoNest } from './nestingEngine'
import { generatePair, pairMemberInstances, planSharedCuts, sharedSource, worldPairTabs, minimumSharedBorderMm, sharedBorder } from './sharedCuts'
import { buildTabMap } from '../printing/tabMap'
import { transformLocalPoint } from '../gcode/transform'
import { camPreset } from '../cam/types'
import type { Sheet } from '../models/Sheet'
import type { Part } from '../models/Part'

export function rectanglePart(id = 'panel', width = 200, height = 300, drill = false): Part {
  const dxf = [0,'SECTION',2,'HEADER',9,'$INSUNITS',70,4,0,'ENDSEC',0,'SECTION',2,'ENTITIES',0,'LWPOLYLINE',8,'PROFILE',90,4,70,1,10,0,20,0,10,width,20,0,10,width,20,height,10,0,20,height,...(drill ? [0,'CIRCLE',8,'DRILL',10,40,20,40,40,3] : []),0,'ENDSEC',0,'EOF',''].join('\n')
  const result = generateCam(readDxf(dxf, 'mm'), { thickness:12, profilePasses:4, drillDepthMm:2, rampProfile:'20mm-s-5deg', units:'mm', operations:{}, programs:defaultProgramSettings })
  expect(result.errors).toEqual([])
  return { ...createPartFromGCode(id+'.nc',result.gcode,dxf),id,name:id }
}
export function pairSheet(parts: Part[], mode: 'v1' | 'v2' = 'v2'): Sheet {
  return { name:'Pair test',nestingMethod:mode, width:1200,height:1200,spacing:30,borderSpacing:22,materialProfile:undefined,screwMarkingEnabled:false,gcodeSettings:{...defaultProgramSettings,safeZ:20},instances:parts.map((p,i)=>({id:'i'+i,partId:p.id,partNumber:i+1,x:22,y:22,sheetIndex:0,rotation:0,locked:false})) }
}
function withProfile(parts: Part[], sheet: Sheet) {
  // Original NC with an explicit primary profile, as a catalogue component.
  for(const p of parts) p.metadata.materialVariants={version:1,primaryProfile:'12-4pass-2mm-ramp20-5deg',profiles:{'12-4pass-2mm-ramp20-5deg':{gcode:p.gcode,errors:[],warnings:[]}}} as never
  return sheet
}
describe('V2 shared-edge nesting',()=>{
 it('regenerates a six-tab pair from matching DXFs and cuts the shared edge once per depth',()=>{
  const parts=[rectanglePart('a',200,300,true),rectanglePart('b',180,300,true)],sheet=withProfile(parts,pairSheet(parts))
  const a=sharedSource(parts[0],sheet),b=sharedSource(parts[1],sheet)
  expect(a).toBeDefined();expect(b).toBeDefined()
  const cam=generatePair(a!,b!)
  expect(cam.tabs).toHaveLength(6)
  expect(cam.savedCutMm).toBeGreaterThan(0)
  sheet.instances=autoNest(parts,sheet)
  expect(sheet.instances.map(i=>i.sharedEdgePartnerId)).toEqual(['i1','i0'])
  const plan=planSharedCuts(parts,sheet)
  expect(plan.errors).toEqual([]);expect(plan.pairs).toHaveLength(1)
  expect(validateSheet(parts,sheet).filter(i=>i.level==='error')).toEqual([])
  for(const i of sheet.instances) expect(worldPairTabs(plan.pairs[0],i)).toHaveLength(3)
  const output=exportCombinedGCode(parts,sheet,defaultProgramSettings)
  expect(output.errors).toEqual([])
  expect([...output.gcode.matchAll(/\(Shared edge depth ([\d.]+) mm\)/g)].map(m=>Number(m[1]))).toEqual([3.1,6.2,9.3,12.4])
  expect(output.gcode.match(/Shared edge spring pass/g)).toHaveLength(1)
  expect(output.gcode.match(/drill machining/g)).toHaveLength(2)
  const simulation=simulateGCode(output.gcode)
  expect(simulation.errors).toEqual([]);expect(simulation.deepestCutMm).toBe(12.4)
  expect(simulation.moves.filter(m=>m.type==='rapid' && Math.hypot(m.end.x-m.start.x,m.end.y-m.start.y)>0.001).every(m=>Math.min(m.start.z,m.end.z)>=0)).toBe(true)
  const files=exportPhysicalSheetGCodes(parts,sheet,defaultProgramSettings)
  expect(files[0].errors).toEqual([]);expect(files[0].gcode.match(/Shared edge depth/g)).toHaveLength(4)
 })
 it('retains V1 layout and output when the option is absent, and separates V2 pairs on a V1 re-nest',()=>{
  const parts=[rectanglePart('a'),rectanglePart('b')],sheet=withProfile(parts,pairSheet(parts,'v1'))
  const explicit=autoNest(parts,sheet),legacy=autoNest(parts,{...sheet,nestingMethod:undefined})
  expect(explicit).toEqual(legacy)
  sheet.instances=autoNest(parts,{...sheet,nestingMethod:'v2'})
  expect(exportCombinedGCode(parts,sheet).errors.join(' ')).toContain('require V2')
  sheet.instances=autoNest(parts,sheet)
  expect(sheet.instances.every(i=>!i.sharedEdgePartnerId)).toBe(true)
  expect(validateSheet(parts,sheet).filter(i=>i.level==='error')).toEqual([])
  expect(exportCombinedGCode(parts,sheet).gcode).not.toContain('Shared edge depth')
 })
 it('blocks moved, missing and rotated pair members and waste corridor obstructions',()=>{
  const parts=[rectanglePart('a'),rectanglePart('b')],sheet=withProfile(parts,pairSheet(parts))
  sheet.instances=autoNest(parts,sheet)
  for(const patch of [{x:sheet.instances[1].x+1},{rotation:90},{sharedEdgePartnerId:undefined}]){
   const changed={...sheet,instances:sheet.instances.map((i,n)=>n?{...i,...patch}:i)}
   expect(planSharedCuts(parts,changed).errors.length).toBeGreaterThan(0)
   expect(exportCombinedGCode(parts,changed).errors.length).toBeGreaterThan(0)
  }
  expect(planSharedCuts(parts,{...sheet,instances:sheet.instances.slice(0,1)}).errors.length).toBeGreaterThan(0)
  const extra={...sheet.instances[0],id:'extra',sharedEdgePartnerId:undefined,x:sheet.instances[0].x+1}
  expect(planSharedCuts(parts,{...sheet,instances:[...sheet.instances,extra]}).errors.join(' ')).toContain('corridors')
 })
 it('falls back to separate cuts for unknown source machining and incompatible edge lengths',()=>{
  const parts=[rectanglePart('a'),rectanglePart('b',200,250)],sheet=withProfile(parts,pairSheet(parts))
  expect(autoNest(parts,sheet).every(i=>!i.sharedEdgePartnerId)).toBe(true)
  expect(sharedSource({...parts[0],dxf:undefined},sheet)).toBeUndefined()
  expect(sharedSource({...parts[0],gcode:parts[0].gcode.replaceAll('F3000','F2700')},sheet)).toBeUndefined()
 })
 it.each([0,90,180,270])('preserves dimensions, three tabbed sides and printable tabs at %s degrees',rotation=>{
  const parts=[rectanglePart('a'),rectanglePart('b',180,300)],sheet=withProfile(parts,pairSheet(parts))
  const sources=[sharedSource(parts[0],sheet)!,sharedSource(parts[1],sheet)!] as const
  const cam=generatePair(...sources)
  sheet.instances=pairMemberInstances(cam,{...sheet.instances[0],rotation,x:50,y:50},[sheet.instances[0],sheet.instances[1]],[...sources])
  const plan=planSharedCuts(parts,sheet)
  expect(plan.errors).toEqual([])
  expect(plan.pairs).toHaveLength(1)
  const output=exportCombinedGCode(parts,sheet)
  expect(output.errors).toEqual([])
  const map=buildTabMap(parts,sheet)
  expect(map.parts.map(p=>p.tabs.length)).toEqual([3,3])
  expect(map.parts.flatMap(p=>p.tabs).every(t=>!t.inferred)).toBe(true)
  const slot=cam.shared[0]
  const aFace=parts[0].originalBounds.maxX-camPreset.diameter/2-0.3
  expect(slot.x-aFace).toBeCloseTo(camPreset.diameter/2)
  expect(cam.offsetB-sources[0].width).toBe(camPreset.diameter)
  for(let member=0;member<2;member++){
   const tabs=cam.tabs.filter(t=>t.member===member)
   expect(new Set(tabs.map(t=>Math.abs(t.center.y-13+3)<0.01?'bottom':Math.abs(t.center.y-13-300-3)<0.01?'top':'side'))).toEqual(new Set(['bottom','top','side']))
   for(const tab of tabs){
    const center=transformLocalPoint(cam.part,plan.pairs[0].instance,tab.center)
    expect(map.parts[member].tabs.some(t=>Math.hypot(t.center.x-center.x,t.center.y-center.y)<0.001)).toBe(true)
   }
  }
  const roundTrip=JSON.parse(JSON.stringify(sheet)) as Sheet
  expect(exportCombinedGCode(parts,roundTrip).gcode).toBe(output.gcode)
 })
 it('retains all six tabs in the actual finishing and roughing moves and uses the selected ramp/feed',()=>{
  const parts=[rectanglePart('a'),rectanglePart('b')],sheet=withProfile(parts,pairSheet(parts))
  const cam=generatePair(sharedSource(parts[0],sheet)!,sharedSource(parts[1],sheet)!)
  const sim=simulateGCode(cam.part.gcode)
  for(const tab of cam.tabs){
   const crossing=sim.moves.filter(m=>{
    const dx=m.end.x-m.start.x,dy=m.end.y-m.start.y,len=dx*dx+dy*dy
    if(!len || m.type==='rapid') return false
    const t=((tab.center.x-m.start.x)*dx+(tab.center.y-m.start.y)*dy)/len
    return t>=0&&t<=1&&Math.hypot(m.start.x+t*dx-tab.center.x,m.start.y+t*dy-tab.center.y)<camPreset.diameter/2
   })
   expect(crossing.length).toBeGreaterThan(0)
   expect(crossing.every(m=>Math.min(m.start.z,m.end.z)>=tab.z-0.001)).toBe(true)
  }
  const slotCode=cam.part.gcode.split('(V2 shared edge:')[1].split('(Shared edge spring pass)')[0]
  expect(slotCode).toContain('F3000')
  const slotSim=simulateGCode('G21\nG90\n'+slotCode)
  const ramps=slotSim.moves.filter(m=>m.end.z<m.start.z&&Math.hypot(m.end.x-m.start.x,m.end.y-m.start.y)>0.01)
  expect(ramps.length).toBe(8)
  for(const m of ramps) expect(Math.atan2(m.start.z-m.end.z,Math.hypot(m.end.x-m.start.x,m.end.y-m.start.y))*180/Math.PI).toBeCloseTo(5,4)
  expect(slotCode.match(/F1200/g)).toHaveLength(8)
 })
 it('keeps locked pairs fixed and blocks source changes after nesting',()=>{
  const parts=[rectanglePart('a'),rectanglePart('b')],sheet=withProfile(parts,pairSheet(parts))
  sheet.instances=autoNest(parts,sheet).map(i=>({...i,locked:true}))
  expect(autoNest(parts,sheet)).toEqual(sheet.instances)
  const changed=parts.map((p,i)=>i?{...p,dxf:undefined}:p)
  expect(exportCombinedGCode(changed,sheet).errors.join(' ')).toContain('source')
  expect(()=>autoNest(changed,sheet)).toThrow('locked shared pair')
 })

 it('keeps separate cuts when an internal hole compromises the outer holding rim',()=>{
  const original=rectanglePart('edge-hole',200,300,true)
  const dxf=original.dxf!.replace('10\n40\n20\n40','10\n4\n20\n40')
  const result=generateCam(readDxf(dxf,'mm'),{thickness:12,profilePasses:4,drillDepthMm:2,rampProfile:'20mm-s-5deg',units:'mm',operations:{},programs:defaultProgramSettings})
  expect(result.errors).toEqual([])
  const part=createPartFromGCode('edge-hole.nc',result.gcode,dxf)
  const parts=[part,rectanglePart('second')],sheet=withProfile(parts,pairSheet(parts))
  expect(sharedSource(part,sheet)).toBeUndefined()
  expect(autoNest(parts,sheet).every(i=>!i.sharedEdgePartnerId)).toBe(true)
 })

 it('fits 1186.6 mm panels on 1220 mm stock with a 15 mm border and diagnoses an oversized border',()=>{
  const parts=[rectanglePart('Left side',300,1180),rectanglePart('Right side',300,1180)]
  // Unknown source remains individual machining, as with shaped rack panels.
  const sheet={...pairSheet(parts),width:1220,height:1220,spacing:10,borderSpacing:22}
  expect(()=>autoNest(parts,sheet)).toThrow('Set Border to 13 mm')
  expect(sheet.instances.every(i=>i.x===22)).toBe(true)
  expect(minimumSharedBorderMm-camPreset.diameter/2).toBe(10)
  expect(sharedBorder({...sheet,borderSpacing:15})).toBe(15)
  expect(sharedBorder({...sheet,borderSpacing:0})).toBe(13)
  for(const borderSpacing of [13,15]){
    const fixed={...sheet,borderSpacing}
    fixed.instances=autoNest(parts,fixed)
    expect(validateSheet(parts,fixed).filter(i=>i.level==='error')).toEqual([])
    expect(Math.max(...fixed.instances.map(i=>i.sheetIndex))).toBe(0)
    expect(exportCombinedGCode(parts,fixed).errors).toEqual([])
  }
  expect(()=>autoNest(parts,{...sheet,width:1000,height:1000})).toThrow('Use a larger sheet')
 })

})
