import { describe, expect, it } from 'vitest'
import { generateCam, materialPreset } from './generate'
import { generateMaterialVariants } from './materialVariants'
import { materialProfiles } from './materialProfiles'
import { arcPoints, distance } from './geometry'
import { simulateGCode } from '../gcode/simulator'
import { createPartFromGCode } from '../gcode/importPart'
import { exportCombinedGCode, exportPhysicalSheetGCodes } from '../gcode/exporter'
import type { Sheet } from '../models/Sheet'
import type { CamDrawing, CamFeature, CamSettings } from './types'
import { generateDxfNc } from '../../api/dxf'

const rectangle = (width = 200, height = 120) => [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]
const feature = (kind: CamFeature['kind'] = 'outside'): CamFeature => ({ id: 'f', name: 'Panel', layer: '0', kind, closed: true, points: rectangle(), depthMm: 5 })
const drawing = (f = feature()): CamDrawing => ({ features: [f], errors: [], warnings: [], units: 'mm' })
const settings: CamSettings = { thickness: 18, units: 'mm', operations: { f: { cornerOvercuts: false } } }
const sections = (gcode: string) => {
  const line = gcode.split('\n').findIndex(line => line.startsWith('(Finishing pass:')) + 1
  const simulation = simulateGCode(gcode)
  return {
    rough: simulation.moves.filter(move => move.lineNumber < line && move.type !== 'rapid' && move.end.z < 0),
    finish: simulation.moves.filter(move => move.lineNumber > line && move.type !== 'rapid' && move.end.z < 0),
  }
}

describe('Default full-depth finishing', () => {
  it.each(['outside', 'inside', 'pocket'] as const)('leaves 0.3 mm on %s walls and finishes at the final depth', kind => {
    const job = generateCam(drawing(feature(kind)), settings)
    expect(job.errors).toEqual([])
    const depth = kind === 'pocket' ? 5 : 18.4
    expect(job.gcode).toContain(`(Finishing pass: 0.3 mm allowance / full depth ${depth} mm)`)
    const { rough, finish } = sections(job.gcode)
    const roughMin = Math.min(...rough.map(move => move.end.x))
    const finishMin = Math.min(...finish.map(move => move.end.x))
    expect(roughMin - finishMin).toBeCloseTo(kind === 'outside' ? -0.3 : 0.3, 4)
    expect(finish.some(move => move.start.z === -depth && move.end.z === -depth && distance(move.start, move.end) > 10)).toBe(true)
    expect(job.simulation.deepestCutMm).toBe(depth)
    expect(job.simulation.moves.filter(move => move.type === 'rapid' && distance(move.start, move.end) > 0.001).every(move => move.start.z === 20 && move.end.z === 20)).toBe(true)
  })

  it.each(['rectangle', 'rotated', 'circle', 'inside circle'] as const)('keeps the finished tabs intact on both contours of a %s', shape => {
    const f = feature(shape === 'inside circle' ? 'inside' : 'outside')
    if (shape.includes('circle')) {
      f.circle = { center: { x: 0, y: 0 }, radius: 50 }
      f.points = arcPoints(f.circle.center, f.circle.radius, 0, Math.PI * 2).slice(0, -1)
    } else if (shape === 'rotated') f.points = f.points.map(({ x, y }) => ({ x: x * Math.cos(0.7) - y * Math.sin(0.7), y: x * Math.sin(0.7) + y * Math.cos(0.7) })).reverse()
    const job = generateCam(drawing(f), settings)
    expect(job.errors).toEqual([])
    expect(job.operations[0].tabs).toHaveLength(4)
    const { rough, finish } = sections(job.gcode)
    for (const tab of job.operations[0].tabs) {
      let remaining = tab.points.slice(1).reduce((sum, point, i) => sum + distance(tab.points[i], point), 0) / 2
      let midpoint = tab.start
      for (let i = 1; i < tab.points.length; i++) {
        const a = tab.points[i - 1], b = tab.points[i], length = distance(a, b)
        if (remaining <= length) { midpoint = { x: a.x + (b.x - a.x) * remaining / length, y: a.y + (b.y - a.y) * remaining / length }; break }
        remaining -= length
      }
      for (const moves of [rough, finish]) {
        const acrossTab = moves.filter(move => {
          const dx = move.end.x - move.start.x, dy = move.end.y - move.start.y
          if (dx * dx + dy * dy < 0.001) return false
          const t = Math.max(0, Math.min(1, ((midpoint.x - move.start.x) * dx + (midpoint.y - move.start.y) * dy) / (dx * dx + dy * dy)))
          return distance(midpoint, { x: move.start.x + t * dx, y: move.start.y + t * dy }) < 0.32
        })
        expect(acrossTab.length).toBeGreaterThan(0)
        expect(acrossTab.every(move => move.start.z >= -12.4001 && move.end.z >= -12.4001)).toBe(true)
      }
    }
  })

  it('finishes a circular pocket at its specified radius and blind depth', () => {
    const center = { x: 30, y: 30 }, radius = 17.5
    const f = { ...feature('pocket'), points: arcPoints(center, radius, 0, Math.PI * 2).slice(0, -1), circle: { center, radius }, depthMm: 10 }
    const job = generateCam(drawing(f), settings)
    expect(job.errors).toEqual([])
    const shifted = { x: center.x + job.shift.x, y: center.y + job.shift.y }
    const { rough, finish } = sections(job.gcode)
    expect(Math.max(...rough.map(move => distance(move.end, shifted)))).toBeCloseTo(radius - 3 - 0.3, 3)
    const arcs = finish.filter(move => move.type === 'arc-cw')
    expect(arcs).toHaveLength(3)
    for (const move of arcs) {
      expect(distance(move.end, shifted)).toBeCloseTo(radius - 3, 3)
      expect(move.start.z).toBe(-10); expect(move.end.z).toBe(-10)
    }
  })

  it('uses millimetres for the allowance even when the drawing uses inches', () => {
    const source = { ...drawing({ ...feature(), points: rectangle(8, 5) }), units: 'inches' as const }
    const job = generateCam(source, { ...settings, units: 'auto' })
    expect(job.errors).toEqual([])
    const { rough, finish } = sections(job.gcode)
    expect(Math.min(...finish.map(move => move.end.x)) - Math.min(...rough.map(move => move.end.x))).toBeCloseTo(0.3, 4)
  })

  it('includes the finish for every material preset without changing the preset depths', () => {
    const variants = generateMaterialVariants(drawing(), settings)
    for (const profile of materialProfiles) {
      const variant = variants.profiles[profile.id]!
      expect(variant.errors, profile.id).toEqual([])
      const material = materialPreset(profile.thickness, profile.profilePasses, profile.drillDepthMm, profile.rampProfile)
      expect(variant.gcode).toContain(`(Finishing pass: 0.3 mm allowance / full depth ${material.depth} mm)`)
      expect([...variant.gcode.matchAll(/\(Pass depth ([\d.]+) mm\)/g)].map(match => Number(match[1]))).toEqual(material.passes)
    }
  })

  it.each(['slot', 'centreline'] as const)('adds a full-depth spring pass to a %s without shifting its dimensions', kind => {
    const f = { ...feature('inside'), points: kind === 'slot' ? rectangle(100, 6) : rectangle(), toolCentreline: kind === 'centreline' }
    const job = generateCam(drawing(f), settings)
    expect(job.errors).toEqual([])
    expect(job.gcode).toContain(`(Finishing pass: full depth 18.4 mm / ${kind === 'slot' ? 'cutter-width' : 'centreline'} spring pass)`)
    const { rough, finish } = sections(job.gcode)
    expect(Math.min(...rough.map(move => move.end.x))).toBeCloseTo(Math.min(...finish.map(move => move.end.x)), 4)
    expect(finish.some(move => move.start.z === -18.4 && move.end.z === -18.4)).toBe(true)
  })

  it('keeps finishing moves when exporting individual and combined sheets', () => {
    const job = generateCam(drawing(), settings)
    const part = createPartFromGCode('finished.nc', job.gcode)
    const sheet: Sheet = {
      name: 'Finishing export', width: 600, height: 400, spacing: 30, borderSpacing: 10, screwMarkingEnabled: false, safeZOverrideMm: 20,
      gcodeSettings: { startGcode: 'G21\nG17\nG90\nG94', spindleStartGcode: 'S18000 M03', endGcode: 'M05\nM30', safeZ: 20 },
      instances: [{ id: 'one', partId: part.id, x: 20, y: 20, rotation: 0, sheetIndex: 0, locked: false }],
    }
    for (const result of [exportCombinedGCode([part], sheet), ...exportPhysicalSheetGCodes([part], sheet)]) {
      expect(result.errors).toEqual([])
      expect(result.gcode).toContain('(Finishing pass: 0.3 mm allowance / full depth 18.4 mm)')
      expect(simulateGCode(result.gcode).errors).toEqual([])
    }
  })

  it.each([6.5, 6.7])('checks the 6 mm cutter and finishing allowance in a %s mm slot', width => {
    const job = generateCam(drawing({ ...feature('inside'), points: rectangle(100, width) }), settings)
    if (width < 6.6) {
      expect(job.errors.length).toBeGreaterThan(0)
      expect(job.gcode).toBe('')
    } else {
      expect(job.errors).toEqual([])
      expect(job.gcode).toContain('Finishing pass: 0.3 mm allowance')
      expect(Math.max(...job.operations[0].path.map(point => point.y)) - Math.min(...job.operations[0].path.map(point => point.y))).toBeCloseTo(width - 6, 3)
    }
  })

  it('preserves short pocket-ramp depths when sheet export formats the program', () => {
    const points = [[0, 0], [100, 0], [100, 70], [70, 70], [70, 25], [30, 25], [30, 70], [0, 70]].map(([x, y]) => ({ x, y }))
    const job = generateCam(drawing({ ...feature('pocket'), points, depthMm: 6 }), { ...settings, thickness: 12 })
    expect(job.errors).toEqual([])
    const part = createPartFromGCode('pocket.nc', job.gcode)
    const sheet: Sheet = {
      name: 'Pocket finish', width: 600, height: 400, spacing: 30, borderSpacing: 10, screwMarkingEnabled: false, safeZOverrideMm: 20,
      gcodeSettings: { startGcode: 'G21\nG17\nG90\nG94', spindleStartGcode: 'S18000 M03', endGcode: 'M05\nM30', safeZ: 20 },
      instances: [{ id: 'pocket', partId: part.id, x: 20, y: 20, rotation: 37, sheetIndex: 0, locked: false }],
    }
    for (const result of [exportCombinedGCode([part], sheet), ...exportPhysicalSheetGCodes([part], sheet)]) {
      expect(result.errors).toEqual([])
      for (const move of simulateGCode(result.gcode).moves) {
        const length = distance(move.start, move.end)
        if (move.type !== 'rapid' && move.end.z < move.start.z && length > 0.001) {
          expect((move.start.z - move.end.z) / length).toBeLessThanOrEqual(Math.tan(3 * Math.PI / 180) + 0.001)
        }
      }
    }
  })

  it('enables finishing in API generation without any extra request setting', async () => {
    const dxf = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', 0, 'LWPOLYLINE', 8, 'PROFILE', 90, 4, 70, 1, 10, 0, 20, 0, 10, 200, 20, 0, 10, 200, 20, 120, 10, 0, 20, 120, 0, 'CIRCLE', 8, 'DRILL', 10, 50, 20, 50, 40, 3, 0, 'ENDSEC', 0, 'EOF', ''].join('\n')
    const result = await generateDxfNc({ dxf, thicknessMm: 12, variantProfiles: ['12'] })
    expect(result.settings).toMatchObject({ finishingAllowanceMm: 0.3, fullDepthFinishing: true })
    expect(result.gcode).toContain('(Finishing pass: 0.3 mm allowance / full depth 12.2 mm)')
    const drill = result.operations.find(operation => operation.kind === 'drill')!
    const block = result.gcode.split('\n').slice(drill.firstLine - 1, drill.lastLine).join('\n')
    expect(block).not.toContain('Finishing pass:')
    expect(block).toContain('G01 Z-4.5 F600\nG00 Z20')
  })
})
