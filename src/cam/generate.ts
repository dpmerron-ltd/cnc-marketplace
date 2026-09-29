import type { Point } from '../models/geometry'
import { simulateGCode } from '../gcode/simulator'
import { calculateMachiningBounds } from '../gcode/bounds'
import { parseGCode } from '../gcode/parser'
import { defaultProgramSettings, programLines, startProgramLines, validatePrograms } from '../gcode/programSettings'
import { hasControllerStart } from '../gcode/controllerStart'
import { arcPoints, area, contains, cornerOvercuts, distance, intersectionArea, offset, pathMetric, pocketPaths } from './geometry'
import { camPreset, cutterWidthOpening, defaultTabCount, requiresHoldingTabs, tabFreeOpening } from './types'
import { cutterWidthGeometry } from './rectangle'
import type { CamDrawing, CamFeature, CamOperation, CamResult, CamSettings } from './types'
import { materialProfileId, rampPreset } from './materialProfiles'
import { profileEntry, routeOperations, type RouteOperation } from './routing'

const toolRadius = camPreset.diameter / 2
const n = (value: number) => Number(value.toFixed(4)).toString()
const xy = (p: Point) => `X${n(p.x)} Y${n(p.y)}`
const comment = (value: string) => value.replace(/[^a-zA-Z0-9 _.,:/-]/g, '_').slice(0, 120)
export const materialPreset = (thickness: CamSettings['thickness'], profilePasses: CamSettings['profilePasses'] = 1, drillDepthMm?: CamSettings['drillDepthMm'], rampProfile?: CamSettings['rampProfile']) => {
  if (materialProfileId(thickness, profilePasses, drillDepthMm, rampProfile) === '12-2pass-2mm-ramp20-5deg') return { depth: 12.2, passes: [6, 12.2], drill: 2 }
  return thickness === 18 ? { depth: 18.4, passes: [9.2, 18.4], drill: drillDepthMm ?? 9.2 } : thickness === 15 ? { depth: 15.4, passes: [7.7, 15.4], drill: 9.2 } : thickness === 6 ? { depth: 6.2, passes: [6.2], drill: 4.5 } : { depth: 12.2, passes: profilePasses === 2 ? [6.1, 12.2] : [12.2], drill: drillDepthMm ?? 4.5 }
}

function tabIntervals(path: Point[], count: number, circular: boolean): Array<[number, number]> {
  const metric = pathMetric(path), width = camPreset.tabWidth + camPreset.diameter
  if (circular) {
    const fitted = Math.min(count, Math.floor(metric.length / (width + camPreset.diameter * 2)))
    return Array.from({ length: fitted }, (_, i) => [(i + 0.5) * metric.length / fitted - width / 2, (i + 0.5) * metric.length / fitted + width / 2])
  }
  const candidates: number[] = []
  for (let i = 0; i < path.length; i++) {
    const length = metric.cumulative[i + 1] - metric.cumulative[i]
    if (length < width + camPreset.diameter) continue
    for (const fraction of [0.5, 0.25, 0.75]) {
      const s = length * fraction
      if (s > width / 2 + toolRadius && s < length - width / 2 - toolRadius) candidates.push(metric.cumulative[i] + s)
    }
  }
  const chosen: number[] = []
  const separation = (a: number, b: number) => Math.min(Math.abs(a - b), metric.length - Math.abs(a - b))
  while (chosen.length < count && candidates.length) {
    candidates.sort((a, b) => Math.min(...chosen.map(c => separation(b, c)), metric.length) - Math.min(...chosen.map(c => separation(a, c)), metric.length))
    const value = candidates.shift()!
    if (chosen.every(c => separation(value, c) >= width + camPreset.diameter * 2)) chosen.push(value)
  }
  return chosen.sort((a, b) => a - b).map(s => [s - width / 2, s + width / 2])
}

function rotatePath(path: Point[], start: number): Point[] {
  const metric = pathMetric(path)
  const positions = [...metric.cumulative.slice(0, -1).filter(s => s > start + 1e-6), ...metric.cumulative.slice(0, -1).filter(s => s < start - 1e-6)]
  return [metric.at(start), ...positions.map(s => metric.at(s))]
}

function prepareProfile(f: CamFeature, settings: CamSettings) {
  const onLine = f.toolCentreline && f.kind === 'inside'
  let path = onLine ? f.points.map(point => ({ ...point })) : offset(f.points, f.kind === 'outside' ? toolRadius : -toolRadius)
  let centers: Point[] = []
  if (f.kind === 'inside' && !onLine && !f.circle && settings.operations[f.id]?.cornerOvercuts !== false) {
    const relief = cornerOvercuts(f.points, [path], toolRadius)
    path = relief.paths[0]; centers = relief.centers
  }
  if ((area(path) > 0) !== (f.kind === 'outside')) path.reverse()
  const tabFree = tabFreeOpening(f), warnings: string[] = []
  let requestedTabs = tabFree ? 0 : settings.operations[f.id]?.tabs ?? defaultTabCount(f)
  if (!Number.isInteger(requestedTabs) || requestedTabs < 0 || requestedTabs > 4) throw new Error('Tab count must be an integer from 0 to 4.')
  const tabsRequired = requiresHoldingTabs(f)
  if (tabsRequired && !requestedTabs) throw new Error('Doors and outside profiles larger than 12 mm in X or Y require holding tabs. Set a tab count from 1 to 4.')
  const intervals = tabIntervals(path, requestedTabs, Boolean(f.circle))
  if (requestedTabs && !intervals.length) {
    if (tabsRequired) throw new Error('No segment can hold a 10 mm tab. This through-cut cannot be exported without holding tabs; revise the geometry.')
    warnings.push(`${f.name}: tabs automatically removed because no 10 mm tab fits; verify cutout waste cannot move into the cutter.`)
    requestedTabs = 0
  }
  if (intervals.length < requestedTabs) warnings.push(`${f.name}: ${intervals.length} of ${requestedTabs} tabs fit with the required spacing.`)
  if (!requestedTabs && !tabFree) warnings.push(`${f.name}: no holding tabs; verify independent workholding.`)
  return { path, intervals, centers, warnings, onLine }
}

export function generateCam(drawing: CamDrawing, settings: CamSettings): CamResult {
  const rampSettings = rampPreset(settings.rampProfile)
  const slope = Math.tan(rampSettings.rampDegrees * Math.PI / 180)
  const errors = [...drawing.errors], warnings = [...drawing.warnings]
  if (settings.rampProfile !== undefined && !materialProfileId(settings.thickness, settings.profilePasses, settings.drillDepthMm, settings.rampProfile)) errors.push('The 20 mm/s, 5 degree ramp requires 12 mm stock with one pass and standard drills, 12 mm stock with two passes and 2 mm drills, or 18 mm stock with 9 mm drills.')
  const programs = settings.programs ?? defaultProgramSettings
  errors.push(...validatePrograms(programs, camPreset.clearance))
  const material = materialPreset(settings.thickness, settings.profilePasses, settings.drillDepthMm, settings.rampProfile)
  if (settings.drillDepthMm !== undefined && !materialProfileId(settings.thickness, settings.profilePasses, settings.drillDepthMm, settings.rampProfile)) errors.push('Use a supported material, pass, drill depth and ramp combination.')
  if (![6, 12, 15, 18].includes(settings.thickness)) errors.push('Select 6 mm, 12 mm, 15 mm or 18 mm material.')
  if (settings.profilePasses !== undefined && (settings.thickness !== 12 || ![1, 2].includes(settings.profilePasses))) errors.push('Profile pass selection is only supported for 12 mm stock: choose 1 or 2 passes.')
  const factor = (settings.units === 'auto' ? drawing.units : settings.units) === 'inches' ? 25.4 : 1
  const features = drawing.features.map(f => ({ ...f, points: f.points.map(p => ({ x: p.x * factor, y: p.y * factor })), circle: f.circle ? { center: { x: f.circle.center.x * factor, y: f.circle.center.y * factor }, radius: f.circle.radius * factor } : undefined, ...settings.operations[f.id] }))
  const active = features.filter(f => f.kind !== 'ignore')
  const allPoints = active.flatMap(f => f.points)
  const minX = Math.min(...allPoints.map(p => p.x)), minY = Math.min(...allPoints.map(p => p.y))
  const shift = { x: 10 + toolRadius - (Number.isFinite(minX) ? minX : 0), y: 10 + toolRadius - (Number.isFinite(minY) ? minY : 0) }
  for (const f of features) {
    f.points = f.points.map(p => ({ x: p.x + shift.x, y: p.y + shift.y }))
    if (f.circle) f.circle.center = { x: f.circle.center.x + shift.x, y: f.circle.center.y + shift.y }
  }
  if (!active.length) errors.push('No operations are selected.')
  const operations: CamOperation[] = []
  const lines: string[] = []
  const emit = (...code: string[]) => { lines.push(...code); if (lines.length > 50000) throw new Error('Generated program exceeds 50,000 lines. Split the drawing.') }
  const linear = (point: Point, depth: number, feed: number) => emit(`G01 ${xy(point)} Z${n(-depth)} F${feed}`)
  const approach = (point: Point) => emit('G00 Z20', `G00 ${xy(point)}`, 'G00 Z0.5', 'G01 Z0 F600')
  const contours: Array<{ feature: CamFeature; path: Point[] }> = []
  const overcuts: Array<{ feature: CamFeature; centers: Point[] }> = []
  const openingOutlines = new Map(active.flatMap(feature => {
    const rectangle = cutterWidthOpening(feature)
    return rectangle ? [[feature.id, cutterWidthGeometry(rectangle, camPreset.diameter, false).outline] as const] : []
  }))
  const predecessors = new Map(active.map(feature => [feature.id, new Set<string>()]))
  const relieve = (feature: CamFeature, paths: Point[][]) => {
    if (feature.circle || settings.operations[feature.id]?.cornerOvercuts === false) return paths
    const result = cornerOvercuts(feature.points, paths, toolRadius)
    if (result.centers.length) {
      overcuts.push({ feature, centers: result.centers })
      emit(`(Automatic corner overcuts: ${result.centers.length})`)
      warnings.push(`${feature.name}: ${result.centers.length} dogbone corner overcuts extend beyond the DXF outline.`)
    }
    return result.paths
  }

  // Reject intersecting/duplicate outlines before applying tool compensation.
  const closed = active.filter(f => f.closed && f.kind !== 'drill' && f.kind !== 'unassigned')
  for (let i = 0; i < closed.length; i++) for (const b of closed.slice(i + 1)) {
    const a = closed[i], overlap = intersectionArea(a.points, b.points), aa = Math.abs(area(a.points)), ba = Math.abs(area(b.points))
    if (overlap > 0.05 && (Math.abs(aa - ba) < 0.05 && Math.abs(overlap - aa) < 0.05 || overlap < Math.min(aa, ba) - 0.05)) errors.push(`${a.name} and ${b.name} overlap or duplicate each other.`)
    if (a.kind === 'outside' && b.kind === 'outside' && (contains(a.points, b.points[0]) || contains(b.points, a.points[0]))) errors.push(`${a.name} and ${b.name}: nested outer profiles need an inside/outside review.`)
    if ((a.kind === 'pocket' && overlap > 0.05 && Math.abs(overlap - ba) < 0.05) || (b.kind === 'pocket' && overlap > 0.05 && Math.abs(overlap - aa) < 0.05)) errors.push(`${a.name} and ${b.name}: nested geometry inside a pocket may define an island. Island pockets are not supported; review or explicitly exclude the inner geometry.`)
    if (a.kind === 'inside' && b.kind === 'inside') {
      if (aa > ba + 0.05 && Math.abs(overlap - ba) < 0.05) predecessors.get(a.id)!.add(b.id)
      if (ba > aa + 0.05 && Math.abs(overlap - aa) < 0.05) predecessors.get(b.id)!.add(a.id)
    }
  }
  const rank = { drill: 0, pocket: 1, inside: 2, outside: 3, unassigned: 4, ignore: 5 }
  const sorted = [...active].sort((a, b) => {
    return rank[a.kind] - rank[b.kind] || Math.abs(area(a.points)) - Math.abs(area(b.points))
  })
  const profiles = new Map<string, ReturnType<typeof prepareProfile>>()
  const pockets = new Map<string, Point[][]>()
  const slots = new Map<string, ReturnType<typeof cutterWidthGeometry>>()
  const preparationErrors = new Map<string, unknown>()
  const route = sorted.map((f): RouteOperation & { feature: CamFeature } => {
    let entry: RouteOperation['entry'] = () => ({ point: { x: 0, y: 0 } })
    try {
      if (f.kind === 'drill') {
        const point = f.circle?.center ?? f.points[0]
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Drilling requires a finite centre point.')
        entry = () => ({ point })
      }
      else if (f.kind === 'pocket' && f.circle) {
        const radius = f.circle.radius - toolRadius, center = f.circle.center
        entry = () => ({ point: { x: center.x + Math.min(toolRadius * 0.75, radius), y: center.y }, exit: { x: center.x + radius, y: center.y } })
      } else if (f.kind === 'pocket') {
        const paths = pocketPaths(f.points, toolRadius, camPreset.diameter * 0.4)
        pockets.set(f.id, paths)
        entry = () => ({ point: paths[0][0], exit: paths.at(-1)![0] })
      } else if (f.kind === 'inside' || f.kind === 'outside') {
        const opening = cutterWidthOpening(f)
        if (opening) {
          const geometry = cutterWidthGeometry(opening, camPreset.diameter, settings.operations[f.id]?.cornerOvercuts !== false)
          slots.set(f.id, geometry); entry = () => ({ point: geometry.path[0] })
        } else {
          const profile = prepareProfile(f, settings)
          profiles.set(f.id, profile)
          const passDepth = Math.max(...material.passes.map((depth, i) => depth - (material.passes[i - 1] ?? 0)))
          // Reserve space for the slower standard ramp too, keeping entry geometry stable across ramp presets.
          entry = profileEntry(profile.path, profile.intervals, f.circle ? 0 : toolRadius, passDepth / (2 * Math.tan(camPreset.rampDegrees * Math.PI / 180)))
        }
      }
    } catch (error) { preparationErrors.set(f.id, error) }
    return { id: f.id, feature: f, rank: rank[f.kind], predecessors: predecessors.get(f.id)!, entry }
  })
  // Controller macros may finish at an unknown XY; the origin is only a routing heuristic in that case.
  const origin = hasControllerStart(programs.startGcode) ? { x: 0, y: 0 } : simulateGCode(startProgramLines(programs, 20).join('\n')).moves.at(-1)?.end ?? { x: 0, y: 0 }
  for (const { operation: { feature: f }, entry } of routeOperations(route, origin).steps) {
    try {
      if (f.hinge && settings.thickness <= 12) throw new Error('35 mm hinge pockets are only supported in 15 mm or 18 mm stock. Select 15 mm or 18 mm stock or explicitly exclude the hinge geometry.')
      if (f.kind === 'unassigned') throw new Error('Assign an operation or explicitly exclude this geometry.')
      if (f.kind !== 'drill' && !f.closed) throw new Error('An open contour cannot be machined as a closed profile.')
      if (f.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x > 10000 || p.y > 10000)) throw new Error('Machining coordinates exceed 10,000 mm.')
      if (preparationErrors.has(f.id)) throw preparationErrors.get(f.id)
      const firstLine = lines.length + 1
      emit(`(No. ${operations.length + 1} ${f.kind} machining: ${comment(f.name)})`, `(Feature: ${f.id} / Layer: ${comment(f.layer)})`)
      if (f.kind === 'drill') {
        if (!f.circle && f.points.length !== 1) throw new Error('Drilling requires a circle or DXF point.')
        const center = f.circle?.center ?? f.points[0]
        approach(center)
        const pecks = Math.ceil(material.drill / 2)
        for (let peck = 1; peck <= pecks; peck++) {
          emit(`G01 Z-${n(Math.min(peck * 2, material.drill))} F600`, peck === pecks ? 'G00 Z20' : 'G00 Z0.5')
        }
        operations.push({ featureId: f.id, name: f.name, kind: f.kind, path: [center], tabs: [], depthMm: material.drill, firstLine, lastLine: lines.length })
        continue
      }
      if (f.kind === 'pocket') {
        const depth = f.depthMm
        if (depth === undefined || !Number.isFinite(depth) || depth <= 0 || depth >= settings.thickness) throw new Error(`Set a blind pocket depth greater than 0 and less than ${settings.thickness} mm. Use an inside cut for a through-hole.`)
        const passes = depth > material.passes[0] ? [material.passes[0], depth] : [depth]
        if (!f.circle) {
          const paths = relieve(f, pockets.get(f.id)!)
          let previous = 0
          for (const target of passes) {
            emit(`(Pass depth ${n(target)} mm)`)
            for (const path of paths) {
              const metric = pathMetric(path)
              approach(path[0])
              if (previous) emit(`G01 Z-${n(previous)} F600`)
              // Each closed loop is ramped independently; no uncleared linking cuts.
              const turns = Math.ceil((target - previous) / (metric.length * slope))
              if (turns > 1000) throw new Error('Pocket entry is too small for a ramp.')
              let current = previous
              for (let turn = 0; turn < turns; turn++) {
                const next = Math.min(target, current + metric.length * slope)
                for (const entry of metric.between(0, metric.length)) linear(entry.point, current + (next - current) * entry.s / metric.length, rampSettings.rampFeed)
                current = next
              }
              for (const entry of metric.between(0, metric.length)) linear(entry.point, target, camPreset.cutFeed)
              emit('G00 Z20')
            }
            previous = target
          }
          operations.push({ featureId: f.id, name: f.name, kind: f.kind, path: paths.flat(), tabs: [], depthMm: depth, firstLine, lastLine: lines.length })
          warnings.push(`${f.name}: internal corners and narrow recesses are limited by the 6.35 mm cutter; verify the pocket preview.`)
          continue
        }
        const radius = f.circle.radius - toolRadius, center = f.circle.center
        if (radius < 0.1) throw new Error('Pocket is too small for the 6.35 mm cutter; use cutter-size drilling where appropriate.')
        const entryRadius = Math.min(toolRadius * 0.75, radius)
        const entry = { x: center.x + entryRadius, y: center.y }
        let previous = 0
        for (const target of passes) {
          approach(entry)
          if (previous) emit(`G01 Z-${n(previous)} F600`)
          const turnDepth = Math.PI * 2 * entryRadius * slope
          const turns = Math.ceil((target - previous) / turnDepth)
          let angle = 0, currentDepth = previous
          for (let turn = 0; turn < turns; turn++) for (let third = 0; third < 3; third++) {
            const nextDepth = Math.min(target, currentDepth + turnDepth / 3)
            const start = { x: center.x + Math.cos(angle) * entryRadius, y: center.y + Math.sin(angle) * entryRadius }
            angle -= Math.PI * 2 / 3
            const end = { x: center.x + Math.cos(angle) * entryRadius, y: center.y + Math.sin(angle) * entryRadius }
            emit(`G02 ${xy(end)} Z-${n(nextDepth)} I${n(center.x - start.x)} J${n(center.y - start.y)} F${rampSettings.rampFeed}`)
            currentDepth = nextDepth
          }
          for (let r = entryRadius; ; r = Math.min(radius, r + camPreset.diameter * 0.4)) {
            linear({ x: center.x + r, y: center.y }, target, camPreset.rampFeed)
            for (let third = 1; third <= 3; third++) {
              const a = -(third - 1) * Math.PI * 2 / 3, b = -third * Math.PI * 2 / 3
              emit(`G02 ${xy({ x: center.x + r * Math.cos(b), y: center.y + r * Math.sin(b) })} I${n(-r * Math.cos(a))} J${n(-r * Math.sin(a))} F3000`)
            }
            if (r >= radius - 1e-6) break
          }
          emit('G00 Z20'); previous = target
        }
        operations.push({ featureId: f.id, name: f.name, kind: f.kind, path: offset(f.points, -toolRadius), tabs: [], depthMm: depth, firstLine, lastLine: lines.length })
        continue
      }
      const opening = cutterWidthOpening(f)
      if (opening) {
        const { path, centers, pointHole } = slots.get(f.id)!
        emit(`(Cutter-width rectangular hole: ${n(camPreset.diameter)} mm / no tabs)`)
        if (opening.width < camPreset.diameter - 1e-6) warnings.push(`${f.name}: rectangular hole widened from ${n(opening.width)} mm to the ${camPreset.diameter} mm cutter${opening.length < camPreset.diameter - 1e-6 ? ' in both dimensions' : ''}.`)
        if (centers.length) {
          overcuts.push({ feature: f, centers })
          emit(`(Automatic corner overcuts: ${centers.length})`)
          warnings.push(`${f.name}: ${centers.length} dogbone corner overcuts extend beyond the cutter-width opening.`)
        } else warnings.push(`${f.name}: cutter-width hole has rounded ends/corners; corner overcuts are disabled.`)
        const metric = pathMetric(path)
        approach(path[0])
        let previous = 0
        for (const depth of material.passes) {
          emit(`(Pass depth ${n(depth)} mm)`)
          if (pointHole) {
            const pecks = Math.ceil((depth - previous) / 2)
            for (let peck = 1; peck <= pecks; peck++) {
              emit(`G01 Z-${n(Math.min(previous + peck * 2, depth))} F600`)
              if (peck < pecks) emit('G00 Z0.5')
            }
          } else {
            const turns = Math.ceil((depth - previous) / (metric.length * slope))
            if (turns > 1000) throw new Error('Slot entry is too short for a ramp. Revise the geometry.')
            let current = previous
            for (let turn = 0; turn < turns; turn++) {
              const next = Math.min(depth, current + metric.length * slope)
              for (const entry of metric.between(0, metric.length)) linear(entry.point, current + (next - current) * entry.s / metric.length, rampSettings.rampFeed)
              current = next
            }
          }
          if (metric.length > 1e-6) for (const entry of metric.between(0, metric.length)) linear(entry.point, depth, camPreset.cutFeed)
          previous = depth
          if (pointHole && depth !== material.depth) emit('G00 Z0.5')
        }
        emit('G00 Z20')
        operations.push({ featureId: f.id, name: f.name, kind: f.kind, path, tabs: [], depthMm: material.depth, firstLine, lastLine: lines.length })
        continue
      }
      const profile = profiles.get(f.id)!
      const { onLine, centers } = profile
      let path = profile.path, intervals = profile.intervals
      if (onLine) emit('(Shared release: tool centre follows source contour; no compensation)')
      if (centers.length) {
        overcuts.push({ feature: f, centers })
        emit(`(Automatic corner overcuts: ${centers.length})`)
        warnings.push(`${f.name}: ${centers.length} dogbone corner overcuts extend beyond the DXF outline.`)
      }
      warnings.push(...profile.warnings)
      let metric = pathMetric(path)
      // Rotate the path and tab distances together; winding and physical tab locations stay unchanged.
      const start = entry.start ?? 0
      if (start) {
        const originalLength = metric.length
        intervals = intervals.map(([a, b]) => [(a - start + originalLength) % originalLength, (b - start + originalLength) % originalLength] as [number, number]).sort((a, b) => a[0] - b[0])
        path = rotatePath(path, start); metric = pathMetric(path)
      }
      const follow = (from: number, to: number, zFrom: number, zTo: number, feed: number) => {
        for (const entry of metric.between(from, to)) linear(entry.point, zFrom + (zTo - zFrom) * (entry.s - from) / (to - from), feed)
      }
      const ramp = (position: number, from: number, to: number, available: number) => {
        if (to <= from + 1e-7) return
        available = Math.min(available - 0.05, metric.length - position - 0.05)
        if (available < 0.1) throw new Error('No tab-free ramp space remains.')
        let depth = from, cycles = 0
        while (depth < to - 1e-7) {
          if (++cycles > 1000) throw new Error('Ramp requires too many reversals. Reduce tabs or simplify geometry.')
          const length = Math.min(available, (to - depth) / (2 * slope))
          const next = Math.min(to, depth + 2 * length * slope), halfway = (depth + next) / 2
          follow(position, position + length, depth, halfway, rampSettings.rampFeed)
          follow(position + length, position, halfway, next, rampSettings.rampFeed)
          depth = next
        }
      }
      approach(path[0])
      let previousDepth = 0
      for (const depth of material.passes) {
        emit(`(Pass depth ${n(depth)} mm)`)
        ramp(0, previousDepth, depth, intervals[0]?.[0] ?? metric.length)
        let position = 0
        for (let i = 0; i < intervals.length; i++) {
          const [a, b] = intervals[i]
          follow(position, a, depth, depth, camPreset.cutFeed)
          const tabDepth = Math.min(depth, material.depth - camPreset.tabHeight)
          emit(`(Tab ${i + 1})`, `G01 Z-${n(tabDepth)} F600`)
          follow(a, b, tabDepth, tabDepth, camPreset.cutFeed)
          ramp(b, tabDepth, depth, (intervals[i + 1]?.[0] ?? metric.length) - b)
          position = b
        }
        follow(position, metric.length, depth, depth, camPreset.cutFeed)
        previousDepth = depth
      }
      emit('G00 Z20')
      operations.push({ featureId: f.id, name: f.name, kind: f.kind, path, tabs: intervals.map(([a, b]) => ({ start: metric.at(a), end: metric.at(b), points: [metric.at(a), ...metric.between(a, b).map(entry => entry.point)] })), depthMm: material.depth, firstLine, lastLine: lines.length })
      contours.push({ feature: f, path })
    } catch (error) { errors.push(`${f.name} (${f.layer}): ${(error as Error).message}`) }
  }
  const outer = contours.filter(c => c.feature.kind === 'outside')
  for (const feature of active.filter(f => openingOutlines.has(f.id))) for (const other of active.filter(f => f.id !== feature.id && f.closed)) {
    const outline = openingOutlines.get(feature.id)!, boundary = openingOutlines.get(other.id) ?? other.points
    const enclosing = Math.abs(intersectionArea(feature.points, other.points) - Math.abs(area(feature.points))) < 0.05
    const overlap = intersectionArea(outline, boundary)
    if (enclosing ? Math.abs(area(outline)) - overlap > 0.05 : overlap > 0.05) errors.push(`${feature.name}: cutter-width opening ${enclosing ? 'breaks through' : 'intersects'} ${other.name}. Move or resize the geometry.`)
  }
  for (const { feature, centers } of overcuts) for (const other of active.filter(f => f.id !== feature.id && f.closed)) {
    const enclosing = Math.abs(intersectionArea(feature.points, other.points) - Math.abs(area(feature.points))) < 0.05
    for (const center of centers) {
      const footprint = arcPoints(center, toolRadius, 0, Math.PI * 2).slice(0, -1)
      const overlap = intersectionArea(footprint, openingOutlines.get(other.id) ?? other.points)
      if (enclosing ? Math.abs(area(footprint)) - overlap > 0.05 : overlap > 0.05) {
        errors.push(`${feature.name}: corner overcut ${enclosing ? 'breaks through' : 'intersects'} ${other.name}. Disable corner overcuts or change the geometry.`)
        break
      }
    }
  }
  for (let i = 0; i < outer.length; i++) for (const other of outer.slice(i + 1)) {
    if (intersectionArea(outer[i].path, other.path) > 0.01) errors.push(`${outer[i].feature.name} and ${other.feature.name}: outside cutter paths overlap. Increase drawing spacing.`)
  }
  const cutPoints = operations.flatMap(op => op.path)
  const exactBounds = calculateMachiningBounds(parseGCode(['G21', 'G17', 'G90', ...lines].join('\n')))
  const maxX = Math.ceil(Math.max(0, exactBounds.maxX, ...cutPoints.map(p => p.x)) * 10000) / 10000
  const maxY = Math.ceil(Math.max(0, exactBounds.maxY, ...cutPoints.map(p => p.y)) * 10000) / 10000
  if (maxX > 10000 || maxY > 10000) errors.push('Compensated machining extent exceeds 10,000 mm.')
  const header = [`(DXF CAM - ${hasControllerStart(programs.startGcode) ? 'DUET' : 'DDCS 4.1'} - OPERATOR REVIEW REQUIRED)`, `(Material ${settings.thickness} mm / cutter 6.35 mm / drill depth ${material.drill} mm / peck 2 mm)`, `(Ramp ${rampSettings.rampDegrees} degrees F${rampSettings.rampFeed} / cutting F3000 / tabs 10 mm wide, 6 mm above final depth)`, `(Drawing translation X${n(shift.x)} Y${n(shift.y)})`, ...startProgramLines(programs, 20), ...programLines(programs.spindleStartGcode)]
  for (const op of operations) { op.firstLine += header.length; op.lastLine += header.length }
  const candidate = [...header, ...lines, 'G00 Z20', 'M05', ...programLines(programs.endGcode), ''].join('\n')
  const simulation = simulateGCode(candidate)
  errors.push(...simulation.errors)
  warnings.push(...simulation.warnings)
  if (!programs.spindleStartGcode.trim()) warnings.push('Manual cutter control: no automatic spindle start. Start and stop the cutter manually; M05 cannot stop a manually switched router.')
  if (simulation.moves.some(m => m.type === 'rapid' && (m.start.z < -0.001 || m.end.z < -0.001) && distance(m.start, m.end) > 0.001)) errors.push('Unexpected below-surface rapid travel.')
  return { drawing: { ...drawing, features }, operations, gcode: errors.length ? '' : candidate, simulation, errors: [...new Set(errors)], warnings: [...new Set(warnings)], shift }
}
