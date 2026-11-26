import { expect, it } from 'vitest'
import { generateCam } from './generate'
import { readDxf } from './dxf'
import { createPartFromGCode } from '../gcode/importPart'
import { withFastFinishing } from './withFastFinishing'
import { parseGCode } from '../gcode/parser'
import { simulateGCode } from '../gcode/simulator'
const dxf=[0,'SECTION',2,'HEADER',9,'$INSUNITS',70,4,0,'ENDSEC',0,'SECTION',2,'ENTITIES',0,'LWPOLYLINE',8,'PROFILE',90,4,70,1,10,0,20,0,10,200,20,0,10,200,20,300,10,0,20,300,0,'CIRCLE',8,'DRILL',10,40,20,40,40,3,0,'ENDSEC',0,'EOF',''].join('\n')
it('speeds only finishing level moves, preserving geometry, roughing, ramps, drilling and tabs',()=>{
 const original=generateCam(readDxf(dxf,'mm'),{thickness:12,units:'mm',operations:{}})
 expect(original.errors).toEqual([])
 const part=createPartFromGCode('test.nc',original.gcode,dxf)
 const next=withFastFinishing(part,1.9,'12')
 const words=(code:string)=>parseGCode(code).bodyLines.map(l=>l.words.filter(w=>w.letter!=='F').map(w=>[w.letter,w.value])).filter(l=>l.length)
 expect(words(next.gcode)).toEqual(words(part.gcode))
 const before=part.gcode.split('(Finishing pass:')[0],after=next.gcode.split('(Finishing pass:')[0]
 expect(after.slice(after.indexOf('(No. 1'))).toBe(before.slice(before.indexOf('(No. 1')))
 expect(next.gcode).toContain('F5700');expect(next.gcode).toContain('/ cutter 6 mm')
 const oldSim=simulateGCode(part.gcode),newSim=simulateGCode(next.gcode)
 expect(newSim.errors).toEqual([]);expect(newSim.estimatedSeconds).toBeLessThan(oldSim.estimatedSeconds)
 for(let i=0;i<oldSim.moves.length;i++)if(oldSim.moves[i].start.z!==oldSim.moves[i].end.z)expect({...newSim.moves[i],lineNumber:0}).toEqual({...oldSim.moves[i],lineNumber:0})
 expect(withFastFinishing(part,1.9,'12')).toBe(next)
 expect(()=>withFastFinishing({...part,gcode:part.gcode.replace('cutter 6 mm','cutter 6.35 mm')},1.9,'12')).toThrow('6 mm cutter')
})
it('does not invent finishing movements for unclassified imported NC',()=>{
 const part=createPartFromGCode('old.nc','G21\nG90\nG0 Z20\nG0 X0 Y0\nG1 Z-2 F600\nG1 X50 F1000\nG0 Z20\nM30')
 const next=withFastFinishing(part,1.9)
 expect(next.gcode).toBe(part.gcode);expect(next.metadata.warnings.join()).toContain('original feeds are retained')
})
