import { describe, expect, it } from 'vitest'
import ClipperLib from 'clipper-lib'
import p21Dxf from './fixtures/P21.dxf?raw'
import { readDxf } from '../cam/dxf'
import { generateCam } from '../cam/generate'
import { createPartFromGCode } from '../gcode/importPart'
import { footprintsOverlap, instanceFootprint, partFootprint, toPath } from '../gcode/footprint'
import { instanceBounds, transformLocalPoint, transformPartProgram } from '../gcode/transform'
import { validateSheet } from '../gcode/validator'
import { exportCombinedGCode } from '../gcode/exporter'
import { simulateGCode } from '../gcode/simulator'
import { defaultProgramSettings } from '../gcode/programSettings'
import { rectsOverlap, rotateVector } from '../models/geometry'
import type { Point } from '../models/geometry'
import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import { autoNest, partFitsSheet } from './nestingEngine'
import { generateJob, parseJobRequest } from '../jobs/generateJob'
import { testItem, testRequest } from '../test/jobFixtures'

function polygonPart(name: string, points: Point[]) {
  return createPartFromGCode(`${name}.nc`, ['G21', 'G17', 'G90', 'G00 Z20', `G00 X${points[0].x} Y${points[0].y}`, 'G01 Z-6.2 F600', ...[...points.slice(1), points[0]].map(p => `G01 X${p.x} Y${p.y} F3000`), 'G00 Z20', 'M30'].join('\n'))
}
const diamond = () => polygonPart('diagonal', [{ x: 0, y: 20 }, { x: 20, y: 0 }, { x: 200, y: 180 }, { x: 180, y: 200 }])
const square = () => polygonPart('small', [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }])
function sheetFor(parts: Part[]): Sheet {
  return { name: 'Shape nesting', width: 240, height: 240, borderSpacing: 10, spacing: 10, screwMarkingEnabled: false, safeZOverrideMm: 20, gcodeSettings: { ...defaultProgramSettings, safeZ: 20 }, instances: parts.map((part, i) => ({ id: `instance-${i}`, partId: part.id, partNumber: i + 1, sheetIndex: 0, x: 10, y: 10, rotation: 0, locked: false })) }
}

describe('shape-aware sheet nesting', () => {
  it('uses the triangle beside a locked diagonal instead of reserving its bounding rectangle', () => {
    const parts = [diamond(), square()]
    const sheet = sheetFor(parts)
    sheet.instances[0].locked = true
    sheet.instances = autoNest(parts, sheet)
    expect(sheet.instances[0]).toMatchObject({ locked: true, x: 10, y: 10, rotation: 0 })
    expect(sheet.instances.every(i => i.sheetIndex === 0)).toBe(true)
    expect(rectsOverlap(instanceBounds(parts[0], sheet.instances[0]), instanceBounds(parts[1], sheet.instances[1]))).toBe(true)
    expect(footprintsOverlap(instanceFootprint(parts[0], sheet.instances[0]), instanceFootprint(parts[1], sheet.instances[1]), 10)).toBe(false)
    expect(validateSheet(parts, sheet).filter(i => i.level === 'error')).toEqual([])
    expect(exportCombinedGCode(parts, sheet).errors).toEqual([])
    sheet.instances[1] = { ...sheet.instances[1], x: 80, y: 80 }
    expect(validateSheet(parts, sheet).some(i => i.message.includes('overlap'))).toBe(true)
  })

  it('straightens when useful but retains a diagonal when the straightened length cannot fit', () => {
    const part = diamond(), sheet = sheetFor([part])
    sheet.width = 310; sheet.height = 80
    expect(partFitsSheet(part, sheet)).toBe(true)
    sheet.instances = autoNest([part], sheet)
    expect(sheet.instances[0].rotation % 90).toBeCloseTo(45)
    const bounds = instanceBounds(part, sheet.instances[0])
    expect(bounds.maxY - bounds.minY).toBeCloseTo(Math.sqrt(800), 4)
    expect(validateSheet([part], sheet).filter(i => i.level === 'error')).toEqual([])
    const small = sheetFor([part])
    small.width = 220; small.height = 220
    small.instances = autoNest([part], small)
    expect(small.instances[0].rotation % 90).toBe(0)
    expect(validateSheet([part], small).filter(i => i.level === 'error')).toEqual([])
  })

  it('keeps holes and concavities occupied, and uses a rectangle for degenerate paths', () => {
    const part = polygonPart('concave', [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 100, y: 50 }, { x: 0, y: 200 }])
    expect(ClipperLib.Clipper.PointInPolygon({ X: 1000000, Y: 1500000 }, toPath(partFootprint(part)))).not.toBe(0)
    const line = createPartFromGCode('open.nc', 'G21\nG90\nG01 X0 Y0\nG01 X100 Y50\nM30')
    expect(partFootprint(line)).toHaveLength(4)
    expect(Math.abs(ClipperLib.Clipper.Area(toPath(partFootprint(line)))) / 1e8).toBe(5000)
  })

  it('enforces spacing symmetrically for diagonal and rectangular outlines', () => {
    const a = partFootprint(diamond()), b = partFootprint(square())
    for (let x = 0; x < 180; x += 7) {
      const moved = b.map(p => ({ x: p.x + x, y: p.y }))
      expect(footprintsOverlap(a, moved, 10)).toBe(footprintsOverlap(moved, a, 10))
    }
    expect(footprintsOverlap(a, b, 10)).toBe(true)
  })

  it('reserves unsafe low XY travel but excludes replaced startup and footer positioning', () => {
    const source = 'G21\nG90\nG00 X100 Y100\nG01 Z-2 F600\nG01 X200 Y100 F3000\nG01 X200 Y200\nG01 X100 Y200\nG01 X100 Y100\nG00 Z20\nG00 X0 Y0\nM30'
    const part = createPartFromGCode('travel.nc', source)
    expect(Math.min(...partFootprint(part).map(p => p.x))).toBe(100)
    const low = createPartFromGCode('low-travel.nc', source.replace('G01 X100 Y100\nG00 Z20', 'G01 X100 Y100\nG00 X20 Y20\nG01 X100 Y100\nG00 Z20'))
    expect(Math.min(...partFootprint(low).map(p => p.x))).toBe(20)
    const sheet = sheetFor([low]); sheet.instances = autoNest([low], sheet)
    expect(instanceBounds(low, sheet.instances[0]).minX).toBeGreaterThanOrEqual(10)
    expect(validateSheet([low], sheet).filter(i => i.level === 'error')).toEqual([])
  })

  it('keeps exact spacing on mixed orientations and preserves locked placements on later sheets', () => {
    const parts = Array.from({ length: 8 }, (_, i) => polygonPart(`panel-${i}`, [{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 70, y: 30 }, { x: 0, y: 30 }].map(p => rotateVector(p, i * 13))))
    const sheet = sheetFor(parts)
    sheet.instances[0] = { ...sheet.instances[0], locked: true, sheetIndex: 1, x: 10, y: 10 }
    const locked = { ...sheet.instances[0] }
    sheet.instances = autoNest(parts, sheet)
    expect(sheet.instances[0]).toEqual(locked)
    expect(validateSheet(parts, sheet).filter(i => i.level === 'error')).toEqual([])
    const pointDistance = (p: Point, a: Point, b: Point) => {
      const dx = b.x - a.x, dy = b.y - a.y
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)))
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
    }
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      if (sheet.instances[i].sheetIndex !== sheet.instances[j].sheetIndex) continue
      const a = instanceFootprint(parts[i], sheet.instances[i]), b = instanceFootprint(parts[j], sheet.instances[j])
      const distances = [...a.flatMap(p => b.map((q, k) => pointDistance(p, q, b[(k + 1) % b.length]))), ...b.flatMap(p => a.map((q, k) => pointDistance(p, q, a[(k + 1) % a.length])))]
      expect(Math.min(...distances)).toBeGreaterThanOrEqual(sheet.spacing - 0.0002)
    }
  })

  it('straightens the actual P21 outline after an arbitrary source rotation, preserving depths, feeds and tabs', () => {
    const drawing = readDxf(p21Dxf)
    expect(drawing.errors).toEqual([])
    drawing.features = drawing.features.map(feature => ({ ...feature, points: feature.points.map(p => rotateVector(p, 37)) }))
    const cam = generateCam(drawing, { thickness: 6, units: 'auto', operations: {} })
    expect(cam.errors).toEqual([])
    const part = createPartFromGCode('P21-diagonal.nc', cam.gcode)
    const sheet = sheetFor([part]); sheet.width = 1100; sheet.height = 280
    expect(part.height).toBeGreaterThan(600)
    sheet.instances = autoNest([part], sheet)
    const instance = sheet.instances[0]
    expect(instance.rotation % 90).toBeCloseTo(53, 2)
    const bounds = instanceBounds(part, instance)
    expect(bounds.maxX - bounds.minX).toBeLessThan(973)
    expect(bounds.maxY - bounds.minY).toBeLessThan(207)
    expect(validateSheet([part], sheet).filter(i => i.level === 'error')).toEqual([])
    const transformed = transformPartProgram(part, instance)
    const unchangedWords = (lines: typeof part.parsed.bodyLines) => lines.map(line => line.words.filter(w => !['X', 'Y', 'I', 'J'].includes(w.letter)).map(w => [w.letter, w.value]))
    expect(unchangedWords(transformed.transformedLines)).toEqual(unchangedWords(part.parsed.bodyLines))
    const exported = exportCombinedGCode([part], sheet)
    expect(exported.errors).toEqual([])
    const simulation = simulateGCode(exported.gcode)
    expect(simulation.errors).toEqual([])
    expect(simulation.deepestCutMm).toBe(6.2)
    for (const move of simulation.moves) {
      expect(move.end.x).toBeGreaterThanOrEqual(0); expect(move.end.x).toBeLessThanOrEqual(sheet.width)
      expect(move.end.y).toBeGreaterThanOrEqual(0); expect(move.end.y).toBeLessThanOrEqual(sheet.height)
    }
    expect(part.gcode).toBe(cam.gcode)
  })

  it('rotates modal axes and IJ arc centres by the same angle without changing Z or feed', () => {
    const part = createPartFromGCode('arc.nc', 'G21\nG90\nG00 Z20\nG00 X10 Y0\nG01 Z-2 F600\nG03 X0 Y10 I-10 J0 F3000\nG01 X-10\nG01 Y0\nG00 Z20\nM30')
    const instance = { ...sheetFor([part]).instances[0], rotation: 37 }
    const transformed = transformPartProgram(part, instance)
    expect(transformed.errors).toEqual([])
    const arc = transformed.segments.find(s => s.type === 'arc-ccw')!
    expect(arc.center!.x).toBeCloseTo(transformLocalPoint(part, instance, { x: 0, y: 0 }).x, 8)
    expect(arc.center!.y).toBeCloseTo(transformLocalPoint(part, instance, { x: 0, y: 0 }).y, 8)
    expect(Math.hypot(arc.end.x - arc.center!.x, arc.end.y - arc.center!.y)).toBeCloseTo(10, 8)
    for (const point of simulateGCode(part.gcode).moves.filter(m => m.end.z <= 0).flatMap(m => m.points)) {
      const p = transformLocalPoint(part, instance, point), bounds = instanceBounds(part, instance)
        expect(p.x).toBeGreaterThanOrEqual(bounds.minX - 0.001); expect(p.x).toBeLessThanOrEqual(bounds.maxX + 0.001)
        expect(p.y).toBeGreaterThanOrEqual(bounds.minY - 0.001); expect(p.y).toBeLessThanOrEqual(bounds.maxY + 0.001)
    }
  })

  it('uses straightening in API jobs, including the sheet-size precheck', async () => {
    const part = { ...diamond(), itemId: testItem.id }
    const request = parseJobRequest({ ...testRequest, items: [{ sku: testItem.sku, quantity: 1 }], sheet: { widthMm: 310, heightMm: 80, material: '6 mm ply', spacingMm: 10, borderMm: 10, screwMarks: false } })
    const job = await generateJob(request, [testItem], [part])
    expect(job.manifest.sheets).toHaveLength(1)
    expect(job.sheet.instances[0].rotation % 90).toBeCloseTo(45)
    expect(job.exported[0].errors).toEqual([])
  })
})
