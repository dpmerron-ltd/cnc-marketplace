import {describe,it,expect} from 'vitest'
import {generateCam} from './generate'
import {readDxf} from './dxf'
import {generateMaterialVariants} from './materialVariants'
import {materialProfileId,materialVariantsSchema} from './materialProfiles'
import {rectanglePart,pairSheet} from '../nesting/sharedCuts.test'
import {createPartFromGCode} from '../gcode/importPart'
import {autoNest} from '../nesting/nestingEngine'
import {exportCombinedGCode} from '../gcode/exporter'
import {simulateGCode} from '../gcode/simulator'
import {generateDxfNc} from '../../api/dxf'
const id='18-9mm-finish100-fastpeck-test'
const settings={thickness:18 as const,drillDepthMm:9 as const,rampProfile:'20mm-s-5deg' as const,units:'mm' as const,operations:{}}
describe('isolated 18 mm efficiency trial',()=>{
 it('retains peck depths, Z20 travel, roughing and ramps while speeding cleared-hole return and finishing',()=>{
  const drawing=readDxf(rectanglePart('fixture',200,300,true).dxf!,'mm')
  const normal=generateCam(drawing,settings),trial=generateCam(drawing,{...settings,efficiencyTest:true})
  expect(normal.errors).toEqual([]);expect(trial.errors).toEqual([])
  expect(normal.gcode).not.toContain('F6000');expect(normal.gcode).not.toContain('G00 Z-')
  const drill=trial.gcode.split('(No. 2')[0]
  expect([...drill.matchAll(/G01 Z-([\d.]+) F600/g)].map(m=>Number(m[1]))).toEqual([2,4,6,8,9])
  expect([...drill.matchAll(/G00 Z-([\d.]+)/g)].map(m=>Number(m[1]))).toEqual([1.5,3.5,5.5,7.5])
  const rough=trial.gcode.split('(Roughing:')[1].split('(Finishing pass:')[0],finish=trial.gcode.split('(Finishing pass:')[1]
  expect(rough).toContain('F3000');expect(rough).not.toContain('F6000');expect(finish).toContain('F6000');expect(finish).toContain('F1200')
  expect(trial.simulation.estimatedSeconds).toBeLessThan(normal.simulation.estimatedSeconds)
  expect(trial.simulation.moves.filter(m=>m.type==='rapid'&&Math.hypot(m.end.x-m.start.x,m.end.y-m.start.y)>0.001).every(m=>Math.min(m.start.z,m.end.z)>=20)).toBe(true)
  expect(trial.operations.map(o=>({kind:o.kind,depth:o.depthMm,tabs:o.tabs}))).toEqual(normal.operations.map(o=>({kind:o.kind,depth:o.depthMm,tabs:o.tabs})))
  expect(generateCam(drawing,{...settings,thickness:12,efficiencyTest:true}).errors.length).toBeGreaterThan(0)
 })
 it('keeps normal and test variants distinct and shares the test paths',()=>{
  const parts=['a','b'].map(name=>{
   const source=rectanglePart(name,200,300,true),drawing=readDxf(source.dxf!,'mm'),normal=generateCam(drawing,settings)
   const variants=generateMaterialVariants(drawing,settings,normal,['18-9mm-ramp20-5deg',id])
   expect(variants.primaryProfile).toBe('18-9mm-ramp20-5deg');expect(materialVariantsSchema.safeParse(variants).success).toBe(true)
   expect(variants.profiles[id]?.gcode).toContain('F6000')
   expect(variants.profiles['18-9mm-ramp20-5deg']?.gcode).toBe(normal.gcode)
   const part={...createPartFromGCode(name+'.nc',normal.gcode,source.dxf),id:name};part.metadata.materialVariants=variants;return part
  })
  const sheet={...pairSheet(parts),materialProfile:id as typeof id};sheet.instances=autoNest(parts,sheet)
  const output=exportCombinedGCode(parts,sheet);expect(output.errors).toEqual([]);expect(output.gcode).toContain('1 shared')
  expect(output.gcode).toMatch(/Shared edge finishing left[^]*?F6000/)
  expect(simulateGCode(output.gcode).errors).toEqual([])
 })
 it('exposes the test as an explicit API profile',async()=>{
  const dxf=rectanglePart('fixture',200,300,true).dxf!
  const result=await generateDxfNc({dxf,thicknessMm:18,drillDepthMm:9,rampProfile:'20mm-s-5deg',efficiencyTest:true,variantProfiles:[id]})
  expect(result.materialVariants.primaryProfile).toBe(id);expect(result.gcode).toContain('F6000');expect(result.filename).toContain('TEST')
  expect(materialProfileId(18,undefined,9,'20mm-s-5deg')).toBe('18-9mm-ramp20-5deg')
 })
})
