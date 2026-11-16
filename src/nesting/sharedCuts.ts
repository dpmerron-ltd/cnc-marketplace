import { recordedOperations } from '../cam/sourceOperations'
import { edgeLayouts, layoutFeatures, rectanglePairAnchors } from './sharedGeometry'
import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'
import type { Point, Bounds } from '../models/geometry'
import { rotatePointInBounds } from '../models/geometry'
import { physicalSheet, stockErrors } from '../models/stockMaterial'
import { compatibleCutSides, effectiveCutSide } from '../models/cutSide'
import { readDxf } from '../cam/dxf'
import { generateCam, materialPreset } from '../cam/generate'
import { camPreset, type CamFeature, type CamSettings, type OperationOverride } from '../cam/types'
import { finishingAllowanceMm } from '../cam/finishing'
import { cutFeedPreset, materialProfiles, rampPreset } from '../cam/materialProfiles'
import { rectangleGeometry } from '../cam/rectangle'
import { polygonBounds, boundsPolygon } from '../gcode/footprint'
import { parseGCode } from '../gcode/parser'
import { createPartFromGCode } from '../gcode/importPart'
import { instanceBounds, transformLocalPoint } from '../gcode/transform'
import { selectMaterialParts } from '../gcode/materialSelection'
import { simulateGCode } from '../gcode/simulator'

export const sharedWebMm = camPreset.tabWidth
export const sharedSpacing = (sheet: Sheet) => Math.max(sheet.spacing, camPreset.diameter + sharedWebMm)
export const minimumSharedBorderMm = camPreset.diameter / 2 + sharedWebMm
export const sharedBorder = (sheet: Sheet) => Math.max(sheet.borderSpacing, minimumSharedBorderMm)
const pad = camPreset.diameter / 2 + finishingAllowanceMm
const close = (a: number, b: number) => Math.abs(a - b) < 0.0005
const n = (v: number) => Number(v.toFixed(6))
const signature = (code: string) => JSON.stringify(parseGCode(code).bodyLines.filter(l => l.words.length).map(l => l.words.map(w => [w.letter, w.value])))
export interface SharedSource { part: Part; features: CamFeature[]; settings: CamSettings; bounds: Bounds; width: number; height: number; rectangle: boolean; profile: typeof materialProfiles[number] }
const sources = new WeakMap<Part, Map<string, SharedSource | null>>()

// Reproduce the existing machining before accepting a component for sheet CAM.
// Missing DXFs, edited NC, old cutters and unknown overrides retain V1 cuts.
export function sharedSource(part: Part, sheet: Sheet): SharedSource | undefined {
  const id = sheet.materialProfile ?? part.metadata.materialVariants?.primaryProfile
  const key = JSON.stringify([id, sheet.gcodeSettings])
  let cache = sources.get(part)
  if (!cache) { cache = new Map(); sources.set(part, cache) }
  if (cache.has(key)) return cache.get(key) ?? undefined
  cache.set(key, null)
  const cutter = part.gcode.match(/\(Material[^\n]*\/ cutter ([\d.]+) mm/i)?.[1]
  if (cutter && !close(Number(cutter), camPreset.diameter)) return
  if (!part.dxf || part.dxf.length > 2000000) return
  const profile = materialProfiles.find(p => p.id === id)
  if (!profile) return
  try {
    const drawing = readDxf(part.dxf, 'mm')
    if (drawing.errors.length || drawing.features.length > 100) return
    const provenance = part.metadata as typeof part.metadata & { rackingRegeneration?: { sourceLayerOverrides?: Record<string, OperationOverride> } }
    const settings: CamSettings = { thickness: profile.thickness, profilePasses: [12, 13, 14].includes(profile.thickness) ? profile.profilePasses : undefined, drillDepthMm: profile.drillDepthMm, rampProfile: profile.rampProfile, units: 'mm', operations: provenance.rackingRegeneration?.sourceLayerOverrides ?? {}, programs: sheet.gcodeSettings }
    let features = drawing.features.map(f => ({ ...f, ...settings.operations[f.id] })).filter(f => f.kind !== 'ignore')
    const outer = features.filter(f => f.kind === 'outside')
    if (outer.length !== 1 || outer[0].circle || !outer[0].closed) return
    const rectangle = Boolean(rectangleGeometry(outer[0].points)) && outer[0].points.every((p,i,points)=>{
      const next=points[(i+1)%points.length]
      return close(p.x,next.x)||close(p.y,next.y)
    })
    const bounds = polygonBounds(outer[0].points), width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY
    if (Math.min(width, height) < camPreset.tabWidth + camPreset.diameter) return
    // Tab support is checked for the chosen pair, on its three unshared sides.
    // An operation near another edge must not disqualify the whole component.
    let reproduced = generateCam(drawing, settings)
    if (reproduced.errors.length || signature(reproduced.gcode) !== signature(part.gcode)) {
      const operations = recordedOperations(part.gcode, drawing)
      if (!operations) return
      settings.operations = operations
      reproduced = generateCam(drawing, settings)
      if (reproduced.errors.length || signature(reproduced.gcode) !== signature(part.gcode)) return
      features = drawing.features.map(f => ({ ...f, ...operations[f.id] })).filter(f => f.kind !== 'ignore')
      const effectiveOuter = features.filter(f => f.kind === 'outside')
      if (effectiveOuter.length !== 1 || effectiveOuter[0].id !== outer[0].id) return
    }
    if (!close(part.width, width + pad * 2) || !close(part.height, height + pad * 2)) return
    const source = { part, features, settings, bounds, width, height, rectangle, profile }
    cache.set(key, source)
    return source
  } catch { return }
}

export function sharedSourceIssue(part: Part, sheet: Sheet): string | undefined {
  if (sharedSource(part, sheet)) return
  const diameter = part.gcode.match(/\(Material[^\n]*\/ cutter ([\d.]+) mm/i)?.[1]
  if (diameter && !close(Number(diameter), camPreset.diameter)) return `${part.name}: saved toolpaths use a ${diameter} mm cutter. Regenerate from DXF for the ${camPreset.diameter} mm cutter before V2 can share edges.`
  if (!part.dxf) return `${part.name}: source DXF is missing; V2 cannot regenerate a shared cut.`
  return `${part.name}: V2 could not reproduce the saved machining from its DXF and cutting preset. Review and regenerate this component.`
}

export interface PairCam {
  part: Part
  offsetB: number
  key?: string
  memberLayouts?: Array<{ rotation: number; x: number; y: number; width: number; height: number }>
  tabs: Array<{ points: Point[]; center: Point; member: 0 | 1; z: number }>
  shared: [Point, Point]
  savedCutMm: number
  savedSeconds: number
  memberPaths: [Point[][], Point[][]]
}
const pairCache = new WeakMap<SharedSource, WeakMap<SharedSource, Map<string, PairCam>>>()
export function generatePair(a: SharedSource, b: SharedSource, key?: string): PairCam {
  const layout = key ? edgeLayouts(a,b).find(l=>l.key===key) : !a.rectangle || !b.rectangle || !close(a.height,b.height) ? edgeLayouts(a,b)[0] : undefined
  if (key && !layout || (!a.rectangle || !b.rectangle || !close(a.height,b.height)) && !layout) throw new Error('No straight edge can be shared while retaining tabs on three sides.')
  const cacheKey = layout?.key ?? 'rectangle'
  const cached = pairCache.get(a)?.get(b)?.get(cacheKey)
  if (cached) return cached
  if (a.profile.id !== b.profile.id) throw new Error('Shared edges need matching lengths and cutting presets.')
  const offsetB = a.width + camPreset.diameter, width = offsetB + b.width, height = a.height
  const anchors = layout?.anchors ?? rectanglePairAnchors(a, b)
  if (!anchors) throw new Error('No straight edge can be shared while retaining tabs on three sides.')
  const internals = (s: SharedSource, dx: number, prefix: string) => s.features.filter(f => f.kind !== 'outside').map(f => {
    const translate = (p: Point) => ({ x: p.x - s.bounds.minX + dx, y: p.y - s.bounds.minY })
    return { ...f, id: prefix + f.id, points: f.points.map(translate), circle: f.circle ? { ...f.circle, center: translate(f.circle.center) } : undefined }
  })
  const features: CamFeature[] = [...(layout ? layoutFeatures(layout) : [...internals(a, 0, 'a-'), ...internals(b, offsetB, 'b-')]), { id: 'shared-outer', name: 'Shared pair perimeter', layer: 'PROFILE', kind: 'outside', closed: true, points: layout?.outline ?? boundsPolygon({ minX: 0, minY: 0, maxX: width, maxY: height }), tabAnchors: anchors }]
  const operations = Object.fromEntries(features.filter(f => f.id !== 'shared-outer').map(f => [f.id, { kind: f.kind, depthMm: f.depthMm, ...((f.id.startsWith('a-') ? a : b).settings.operations[f.id.slice(2)] ?? {}) }]))
  const result = generateCam({ features, errors: [], warnings: [], units: 'mm' }, { ...a.settings, operations })
  if (result.errors.length) throw new Error(result.errors.join(' '))
  const outer = result.operations.find(o => o.featureId === 'shared-outer')!
  if (outer.tabs.length !== 6) throw new Error('A shared pair needs three retained tabs per part.')
  const { depth, passes } = materialPreset(a.settings.thickness, a.settings.profilePasses, a.settings.drillDepthMm, a.settings.rampProfile)
  const ramp = rampPreset(a.settings.rampProfile), feed = cutFeedPreset(a.profile.id)
  const x = result.shift.x + (layout?.slot[0].x ?? a.width + camPreset.diameter / 2)
  const bottom = result.shift.y + (layout?.slot[0].y ?? 0) - pad, top = result.shift.y + (layout?.slot[1].y ?? height) + pad
  const shared: [Point, Point] = [{ x, y: bottom }, { x, y: top }]
  const lines = ['(V2 shared edge: cut to final width in depth passes; one spring pass)', '(Both parts remain held on three outer sides)']
  const move = (y: number, z: number, f: number) => lines.push(`G01 X${n(x)} Y${n(y)} Z${n(-z)} F${f}`)
  let previous = 0
  for (const target of passes) {
    lines.push(`(Shared edge depth ${target} mm)`, 'G00 Z20', `G00 X${n(x)} Y${n(bottom)}`, 'G00 Z0.5', `G01 Z${n(-previous)} F600`)
    let current = previous
    while (current < target - 1e-7) {
      const travel = Math.min(top - bottom, (target - current) / (2 * Math.tan(ramp.rampDegrees * Math.PI / 180)))
      const next = Math.min(target, current + 2 * travel * Math.tan(ramp.rampDegrees * Math.PI / 180))
      move(bottom + travel, (current + next) / 2, ramp.rampFeed); move(bottom, next, ramp.rampFeed); current = next
    }
    move(top, target, feed); lines.push('G00 Z20'); previous = target
  }
  lines.push('(Shared edge spring pass)', `G00 X${n(x)} Y${n(bottom)}`, 'G00 Z0.5', `G01 Z-${depth} F600`)
  move(top, depth, feed); lines.push('G00 Z20')
  const code = result.gcode.split('\n'); code.splice(outer.firstLine - 1, 0, ...lines)
  const gcode = code.join('\n'), simulation = simulateGCode(gcode)
  if (simulation.errors.length || !close(simulation.deepestCutMm, depth)) throw new Error('Shared-pair machining failed simulation.')
  const part = createPartFromGCode('shared-pair.nc', gcode)
  part.id = `shared:${a.part.id}:${b.part.id}`; part.name = `${a.part.name} + ${b.part.name}`
  part.cutSide = a.part.cutSide === 'either' || a.part.cutSide === undefined ? b.part.cutSide : a.part.cutSide
  const original = [a, b].map(s => simulateGCode(s.part.gcode))
  const tabs = outer.tabs.map(t => {
    const center = { x: (t.start.x + t.end.x) / 2, y: (t.start.y + t.end.y) / 2 }
    return { points: t.points, center, member: center.x < x ? 0 as const : 1 as const, z: -(depth - camPreset.tabHeight) }
  })
  if (tabs.filter(t => t.member === 0).length !== 3 || tabs.filter(t => t.member === 1).length !== 3) throw new Error('Shared-pair tab distribution is invalid.')
  const sx = result.shift.x, sy = result.shift.y, r = camPreset.diameter / 2
  const memberPaths: [Point[][], Point[][]] = [
    [[{ x, y: sy - r }, { x: sx - r, y: sy - r }, { x: sx - r, y: sy + height + r }, { x, y: sy + height + r }], shared],
    [[{ x, y: sy - r }, { x: sx + width + r, y: sy - r }, { x: sx + width + r, y: sy + height + r }, { x, y: sy + height + r }], shared],
  ]
  if (layout) {
    memberPaths[0] = [shared]; memberPaths[1] = [shared]
    for (let i=0;i<outer.path.length;i++) {
      const start=outer.path[i],end=outer.path[(i+1)%outer.path.length]
      if ((start.x-x)*(end.x-x)<-1e-8) {
        const t=(x-start.x)/(end.x-start.x),middle={x,y:start.y+(end.y-start.y)*t}
        memberPaths[start.x<x?0:1].push([start,middle]);memberPaths[end.x<x?0:1].push([middle,end])
      } else memberPaths[(start.x+end.x)/2<x?0:1].push([start,end])
    }
  }
  for (const op of result.operations.filter(o => o.featureId !== 'shared-outer')) {
    const member = op.featureId.startsWith('a-') ? 0 : 1
    memberPaths[member].push(op.path)
    for (const t of op.tabs) tabs.push({ points: t.points, center: { x: (t.start.x + t.end.x) / 2, y: (t.start.y + t.end.y) / 2 }, member, z: -(depth - camPreset.tabHeight) })
  }
  const cam: PairCam = { part, offsetB, key: layout?.key, memberLayouts: layout?.members.map((m,i)=>({rotation:m.rotation,...layout.offsets[i],width:m.width+2*pad,height:m.height+2*pad})), tabs, shared, memberPaths, savedCutMm: original.reduce((n, s) => n + s.cuttingDistanceMm, 0) - simulation.cuttingDistanceMm, savedSeconds: original.reduce((n, s) => n + s.estimatedSeconds, 0) - simulation.estimatedSeconds }
  let cache = pairCache.get(a); if (!cache) { cache = new WeakMap(); pairCache.set(a, cache) }; let entries=cache.get(b);if(!entries){entries=new Map();cache.set(b,entries)}entries.set(cacheKey,cam)
  return cam
}

export function pairMemberInstances(cam: PairCam, block: PartInstance, members: [PartInstance, PartInstance], sources: [SharedSource, SharedSource]): [PartInstance, PartInstance] {
  return members.map((member, i) => {
    const local = cam.memberLayouts?.[i] ?? {x:i?cam.offsetB:0,y:0,width:sources[i].part.width,height:sources[i].part.height,rotation:0}
    const rect = {minX:local.x,minY:local.y,maxX:local.x+local.width,maxY:local.y+local.height}
    const bounds = polygonBounds(boundsPolygon(rect).map(p => rotatePointInBounds(p, cam.part, block.rotation)))
    return { ...member, x: block.x + bounds.minX, y: block.y + bounds.minY, rotation: (block.rotation + local.rotation) % 360, sheetIndex: block.sheetIndex, sharedEdgePartnerId: members[1 - i].id, sharedEdgeLayoutKey: cam.key }
  }) as [PartInstance, PartInstance]
}
export interface PlacedPair { cam: PairCam; instance: PartInstance; members: [PartInstance, PartInstance]; bounds: Bounds }
export interface SharedPlan { pairs: PlacedPair[]; errors: string[]; pairedIds: Set<string> }

export function planSharedCuts(parts: Part[], sheet: Sheet): SharedPlan {
  const plan: SharedPlan = { pairs: [], errors: [], pairedIds: new Set() }
  if (sheet.nestingMethod !== 'v2') {
    if (sheet.instances.some(i => i.sharedEdgePartnerId)) plan.errors.push('Shared pairs require V2. Auto-nest again with V1 to separate these parts.')
    return plan
  }
  if (![sheet.width, sheet.height, sheet.spacing, sheet.borderSpacing].every(Number.isFinite) || sheet.spacing < 0 || sheet.borderSpacing < 0) { plan.errors.push('V2 needs finite sheet dimensions and non-negative spacing.'); return plan }
  for (const index of new Set(sheet.instances.map(i => i.sheetIndex))) {
    const current = physicalSheet(sheet, index), selection = selectMaterialParts(parts, current)
    plan.errors.push(...selection.errors, ...stockErrors(parts, current))
    const byId = new Map(current.instances.map(i => [i.id, i]))
    const groups: Array<{ bounds: Bounds; ids: string[] }> = []
    for (const first of current.instances) {
      if (plan.pairedIds.has(first.id)) continue
      const firstPart = selection.parts.find(p => p.id === first.partId)
      if (!firstPart) { plan.errors.push('A V2 component is missing.'); continue }
      if (!first.sharedEdgePartnerId) { groups.push({ bounds: instanceBounds(firstPart, first), ids: [first.id] }); continue }
      const second = byId.get(first.sharedEdgePartnerId), secondPart = selection.parts.find(p => p.id === second?.partId)
      if (!second || second.sharedEdgePartnerId !== first.id || second.id === first.id || !secondPart) { plan.errors.push('A shared pair is incomplete. Auto-nest again.'); continue }
      try {
        const firstSource = sharedSource(firstPart, current), secondSource = sharedSource(secondPart, current)
        if (!firstSource || !secondSource || !compatibleCutSides(effectiveCutSide(firstPart, current), effectiveCutSide(secondPart, current))) throw new Error('Shared pair source or cutting face changed. Auto-nest again.')
        if (![first.rotation,second.rotation].every(r=>[0,90,180,270].includes(r)) || first.sharedEdgeLayoutKey !== second.sharedEdgeLayoutKey) throw new Error('Shared pairs must rotate together. Auto-nest again.')
        let found: PlacedPair | undefined
        for (const reverse of [false, true]) {
          const members: [PartInstance, PartInstance] = reverse ? [second, first] : [first, second]
          const sources: [SharedSource, SharedSource] = reverse ? [secondSource, firstSource] : [firstSource, secondSource]
          let cam: PairCam
          try { cam = generatePair(...sources, first.sharedEdgeLayoutKey) } catch { continue }
          const boxes = members.map((m, i) => instanceBounds(sources[i].part, m))
          const instance = { ...members[0], id: `pair:${members[0].id}`, partId: cam.part.id, rotation: (members[0].rotation - (cam.memberLayouts?.[0].rotation ?? 0) + 360) % 360, x: Math.min(...boxes.map(b => b.minX)), y: Math.min(...boxes.map(b => b.minY)) }
          const expected = pairMemberInstances(cam, instance, members, sources)
          if (expected.every((m, i) => close(m.x, members[i].x) && close(m.y, members[i].y) && m.rotation === members[i].rotation)) { found = { cam, instance, members, bounds: instanceBounds(cam.part, instance) }; break }
        }
        if (!found) throw new Error('Shared-edge alignment changed. Auto-nest again before export.')
        plan.pairs.push(found); found.members.forEach(m => plan.pairedIds.add(m.id)); groups.push({ bounds: found.bounds, ids: found.members.map(m => m.id) })
      } catch (error) { plan.errors.push(error instanceof Error ? error.message : 'Invalid shared pair.') }
    }
    // Disjoint rectangular machining envelopes plus continuous waste corridors
    // keep every pair's six tabs connected to the sheet border at every cut stage.
    for (const group of groups) {
      const b = group.bounds, border = sharedBorder(sheet)
      if (b.minX < border - 0.001 || b.minY < border - 0.001 || b.maxX > sheet.width - border + 0.001 || b.maxY > sheet.height - border + 0.001) plan.errors.push(`V2 needs a ${border} mm border. Auto-nest again.`)
    }
    for (let a = 0; a < groups.length; a++) for (let b = a + 1; b < groups.length; b++) {
      const x = groups[a].bounds, y = groups[b].bounds, gap = sharedSpacing(sheet) - 0.001
      if (!(x.maxX + gap <= y.minX || y.maxX + gap <= x.minX || x.maxY + gap <= y.minY || y.maxY + gap <= x.minY)) plan.errors.push('V2 waste corridors are obstructed. Auto-nest again to retain three-sided tab support.')
    }
  }
  plan.errors = [...new Set(plan.errors)]
  return plan
}
export function worldPairTabs(pair: PlacedPair, member: PartInstance) {
  const which = pair.members.findIndex(m => m.id === member.id)
  return pair.cam.tabs.filter(t => t.member === which).map(t => ({ ...t, points: t.points.map(p => transformLocalPoint(pair.cam.part, pair.instance, p)), center: transformLocalPoint(pair.cam.part, pair.instance, t.center) }))
}

export function worldPairPaths(pair: PlacedPair, member: PartInstance) {
  return pair.cam.memberPaths[pair.members.findIndex(m => m.id === member.id)].map(path => path.map(p => transformLocalPoint(pair.cam.part, pair.instance, p)))
}
