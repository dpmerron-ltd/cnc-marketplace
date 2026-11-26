import type { Part } from '../models/Part'
import { simulateGCode } from '../gcode/simulator'
import { createPartFromGCode } from '../gcode/importPart'

const cache = new WeakMap<Part, Map<number, Part>>()
const applied = new WeakMap<Part, number>()
/** Change feed words only in explicitly marked finishing sections. Never change
 * compensation, coordinates, depths, ramps, tab lifts or unclassified NC. */
export function withFastFinishing(part: Part, multiplier: number, _profileId?: string): Part {
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 2) throw Error('Finishing feed multiplier must be between 1 and 2.')
  if (applied.get(part) === multiplier) return part
  const existing=cache.get(part)?.get(multiplier)
  if(existing)return existing
  const cutter=part.gcode.match(/\(Material[^\n]*\/ cutter ([\d.]+) mm/i)?.[1]
  if(cutter && Number(cutter)!==6)throw Error('Saved NC uses a different cutter. Regenerate it for the 6 mm cutter before daily planning.')
  if (!part.gcode.includes('(Finishing pass:')) {
    return { ...part, metadata: { ...part.metadata, warnings: [...part.metadata.warnings, `${part.name}: no identified finishing pass in imported NC; its original feeds are retained.`] } }
  }
  const rough=Number(part.gcode.match(/\(Ramp[^\n]*\/ cutting F([\d.]+)/)?.[1])
  if(!cutter || !Number.isFinite(rough) || rough<=0 || !part.gcode.includes('(DXF CAM -')) throw Error('Cannot identify the saved roughing feed and cutter for fast finishing.')
  const simulation=simulateGCode(part.gcode)
  if(simulation.errors.length)throw Error('Source NC has simulation errors; cannot apply fast finishing.')
  const moves=new Map(simulation.moves.map(move=>[move.lineNumber,move]))
  const feed=Math.round(rough*multiplier*1000)/1000
  let finishing=false,changed=0
  const code=part.gcode.split('\n').map((line,index)=>{
    if(/^\(No\. \d+ /.test(line.trim()) || /^\(End /.test(line.trim()))finishing=false
    if(/^\(Finishing pass:/.test(line.trim()))finishing=true
    const move=moves.get(index+1)
    if(!finishing || !move || move.type==='rapid' || Math.abs(move.start.z-move.end.z)>1e-6 || move.end.z>=0 || move.lengthMm<=0)return line
    // A vertical tab lift has zero XY travel and must keep its original feed.
    if(Math.hypot(move.end.x-move.start.x,move.end.y-move.start.y)<1e-6 && !move.type.startsWith('arc-'))return line
    changed++
    return /\bF[\d.]+/.test(line) ? line.replace(/\bF[\d.]+/,`F${feed}`) : `${line} F${feed}`
  }).join('\n')
  const next=`(Finishing feed ${feed} mm/min / ${multiplier} x cutting feed)\n${code}`
  const generated=createPartFromGCode(part.originalFilename,next,part.dxf,part.itemId)
  const result={...part,...generated,id:part.id,name:part.name,sku:part.sku,ownerId:part.ownerId,dateImported:part.dateImported,cutSide:part.cutSide,stockMaterial:part.stockMaterial,metadata:{...part.metadata,warnings:[...part.metadata.warnings,...(!changed?[`${part.name}: no level finishing moves; original feeds retained.`]:[])]}}
  let entries=cache.get(part);if(!entries){entries=new Map();cache.set(part,entries)}
  entries.set(multiplier,result);applied.set(result,multiplier)
  return result
}
