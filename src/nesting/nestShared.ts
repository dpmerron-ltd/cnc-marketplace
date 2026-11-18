import { edgeLayouts } from './sharedGeometry'
import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'
import { camPreset } from '../cam/types'
import { finishingAllowanceMm } from '../cam/finishing'
import { createPartFromGCode } from '../gcode/importPart'
import { compatibleCutSides, effectiveCutSide } from '../models/cutSide'
import { generatePair, pairMemberInstances, planSharedCuts, sharedBorder, sharedSource, sharedSpacing, minimumSharedBorderMm, type SharedSource, type PairCam } from './sharedCuts'

function envelopePart(part: Part): Part {
  const rectangle = createPartFromGCode('nesting-envelope.nc', `G21\nG90\nG00 Z20\nG00 X0 Y0\nG01 Z-1 F600\nG01 X${part.width} Y0 F3000\nG01 X${part.width} Y${part.height}\nG01 X0 Y${part.height}\nG01 X0 Y0\nG00 Z20\nM30`)
  return { ...rectangle, id: part.id, name: part.name, cutSide: part.cutSide }
}

// Use the unchanged V1 packer to place rectangular envelopes of pair/single units.
export function nestShared(parts: Part[], sheet: Sheet, nestV1: (parts: Part[], sheet: Sheet) => PartInstance[]): PartInstance[] {
  const byPart = new Map(parts.map(p => [p.id, p]))
  const used = new Set<string>(), units: PartInstance[] = [], nestingParts: Part[] = []
  const pairs = new Map<string, { cam: PairCam; members: [PartInstance, PartInstance]; sources: [SharedSource, SharedSource] }>()
  const placedPartIds = new Set(sheet.instances.map(i => i.partId))
  const sources = new Map(parts.filter(p => placedPartIds.has(p.id)).map(p => [p.id, sharedSource(p, sheet)]))
  const current = planSharedCuts(parts, sheet)
  const availableWidth = sheet.width - sharedBorder(sheet) * 2, availableHeight = sheet.height - sharedBorder(sheet) * 2
  for (const instance of sheet.instances.filter(i => !i.locked)) {
    const part = byPart.get(instance.partId)
    if (!part) continue
    const fits = (border: number) => part.width <= sheet.width - 2 * border && part.height <= sheet.height - 2 * border || part.height <= sheet.width - 2 * border && part.width <= sheet.height - 2 * border
    if (!fits(sharedBorder(sheet))) {
      const hint = fits(minimumSharedBorderMm) ? ` Set Border to ${minimumSharedBorderMm} mm (the V2 minimum), then Auto Nest again.` : ' Use a larger sheet.'
      throw new Error(`${part.name}: its ${part.width.toFixed(1)} × ${part.height.toFixed(1)} mm machining envelope cannot fit inside the ${sharedBorder(sheet)} mm border on a ${sheet.width} × ${sheet.height} mm sheet.${hint}`)
    }
  }
  const envelopePadding = camPreset.diameter + 2 * (sheet.skipFinishingPass ? 0 : finishingAllowanceMm)
  const pairFits = (cam: PairCam) => cam.part.width <= availableWidth && cam.part.height <= availableHeight || cam.part.height <= availableWidth && cam.part.width <= availableHeight
  const addPair = (members: [PartInstance, PartInstance], pairSources: [SharedSource, SharedSource], cam: PairCam, existing?: PartInstance) => {
    const id = `shared-unit:${members[0].id}:${members[1].id}`
    const part = { ...cam.part, id }
    nestingParts.push(envelopePart(part))
    units.push({ ...(existing ?? members[0]), id, partId: id, rotation: existing?.rotation ?? 0, sharedEdgePartnerId: undefined, sharedEdgeLayoutKey: undefined, locked: members.some(m => m.locked) })
    pairs.set(id, { members, sources: pairSources, cam }); members.forEach(m => used.add(m.id))
  }
  for (const i of sheet.instances) {
    if (used.has(i.id) || !i.sharedEdgePartnerId) continue
    const partner = sheet.instances.find(p => p.id === i.sharedEdgePartnerId)
    if (!i.locked && !partner?.locked) continue
    const pair = current.pairs.find(p => p.members.some(m => m.id === i.id))
    if (!pair) throw new Error('A locked shared pair is incomplete or has moved. Unlock it and auto-nest again.')
    addPair(pair.members, pair.members.map(m => sources.get(m.partId)!) as [SharedSource, SharedSource], pair.cam, pair.instance)
  }
  // Consider the longest parts first, then choose the greatest cut saving rather
  // than accepting the first short edge encountered in catalogue order.
  const ordered = [...sheet.instances].sort((a,b) => {
    const pa = byPart.get(a.partId), pb = byPart.get(b.partId)
    return Math.max(pb?.width ?? 0,pb?.height ?? 0)-Math.max(pa?.width ?? 0,pa?.height ?? 0)
  })
  for (const a of ordered) {
    if (used.has(a.id)) continue
    const sa = sources.get(a.partId)
    let best: { b: PartInstance; source: SharedSource; cam: PairCam } | undefined
    if (!a.locked && sa) for (const b of sheet.instances) {
      if (a.id === b.id || b.locked || used.has(b.id)) continue
      const sb = sources.get(b.partId)
      if (!sb || sa.profile.id !== sb.profile.id || !compatibleCutSides(effectiveCutSide(sa.part, sheet), effectiveCutSide(sb.part, sheet))) continue
      const legacy = sa.rectangle && sb.rectangle && Math.abs(sa.height-sb.height)<0.0005
      const layouts = edgeLayouts(sa,sb).filter(l=>(l.width+envelopePadding<=availableWidth && l.height+envelopePadding<=availableHeight) || (l.height+envelopePadding<=availableWidth && l.width+envelopePadding<=availableHeight)).slice(0,8)
      for (const key of [...(legacy ? [undefined] : []), ...layouts.map(l=>l.key)]) {
        try {
          const cam = generatePair(sa, sb, key)
          if (!pairFits(cam) || cam.savedCutMm <= 0 || cam.savedSeconds <= 0) continue
          if (!best || cam.savedCutMm > best.cam.savedCutMm) best = { b, source: sb, cam }
        } catch { /* Keep separate machining when a pair cannot be regenerated. */ }
      }
    }
    if (best) { addPair([a, best.b], [sa!, best.source], best.cam); continue }
    const part = byPart.get(a.partId)
    if (!part) throw new Error('A placed part is missing.')
    nestingParts.push(envelopePart(part))
    units.push({ ...a, rotation: a.locked ? a.rotation : 0, sharedEdgePartnerId: undefined, sharedEdgeLayoutKey: undefined }); used.add(a.id)
  }
  const nested = nestV1(nestingParts, { ...sheet, nestingMethod: 'v1', skipFinishingPass: false, materialProfile: undefined, spacing: sharedSpacing(sheet), borderSpacing: sharedBorder(sheet), instances: units })
  const placed = new Map<string, PartInstance>()
  for (const unit of nested) {
    const pair = pairs.get(unit.id)
    if (pair) for (const member of pairMemberInstances(pair.cam, unit, pair.members, pair.sources)) placed.set(member.id, member)
    else placed.set(unit.id, unit)
  }
  return sheet.instances.map(i => placed.get(i.id) ?? i)
}
