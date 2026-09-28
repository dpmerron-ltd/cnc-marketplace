import { describe, expect, it } from 'vitest'
import { generateCam } from './generate'
import { readDxf } from './dxf'
import { generateMaterialVariants } from './materialVariants'
import { materialVariantsSchema } from './materialProfiles'
import type { CamDrawing, CamFeature, CamSettings } from './types'
import { simulateGCode } from '../gcode/simulator'
import { generateDxfNc } from '../../api/dxf'
import { generateJob, parseJobRequest } from '../jobs/generateJob'
import { createPartFromGCode } from '../gcode/importPart'
import { testItem } from '../test/jobFixtures'

const rectangle = (kind: CamFeature['kind'], width = 180, height = 100): CamFeature => ({ id: 'f0', name: 'Test', layer: kind, kind, closed: true, points: [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }] })
const settings: CamSettings = { thickness: 12, units: 'mm', operations: {}, rampProfile: '20mm-s-5deg' }
const drawingFor = (feature: CamFeature): CamDrawing => ({ features: [feature], units: 'mm', warnings: [], errors: [] })
const dxf = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', 0, 'LWPOLYLINE', 8, 'PROFILE', 90, 4, 70, 1, 10, 0, 20, 0, 10, 180, 20, 0, 10, 180, 20, 100, 10, 0, 20, 100, 0, 'ENDSEC', 0, 'EOF', ''].join('\n')

describe('12 mm one-pass 20 mm/s, 5 degree ramp profile', () => {
  it.each([
    rectangle('outside'), rectangle('inside'), rectangle('inside', 60, 6),
    { ...rectangle('pocket'), depthMm: 5 },
    { ...rectangle('pocket'), depthMm: 5, circle: { center: { x: 90, y: 50 }, radius: 20 } },
  ])('uses the configured feed and angle for $kind entries and tab re-entries', feature => {
    const result = generateCam(drawingFor(feature), settings)
    expect(result.errors).toEqual([])
    const ramps = result.simulation.moves.filter(move => move.type !== 'rapid' && move.end.z < move.start.z - 1e-5 && (move.radius || Math.hypot(move.end.x - move.start.x, move.end.y - move.start.y) > 1e-5))
    expect(ramps.length).toBeGreaterThan(0)
    const angles = ramps.map(move => {
      expect(move.feedMmPerMinute).toBe(1200)
      const xy = move.radius ? move.radius * move.sweepRadians! : Math.hypot(move.end.x - move.start.x, move.end.y - move.start.y)
      return Math.atan((move.start.z - move.end.z) / xy) * 180 / Math.PI
    })
    expect(Math.max(...angles)).toBeLessThanOrEqual(5.01)
    if (feature.kind !== 'pocket' || feature.circle) expect(Math.max(...angles)).toBeCloseTo(5, 2)
    const original = generateCam(drawingFor(feature), { ...settings, rampProfile: undefined })
    const geometry = (result: typeof original) => result.operations.map(({ firstLine: _first, lastLine: _last, ...operation }) => operation)
    expect(geometry(result)).toEqual(geometry(original))
    expect(result.simulation.deepestCutMm).toBe(original.simulation.deepestCutMm)
    expect(result.gcode).toContain('F3000')
    expect(result.gcode).toContain('G00 Z20')
  })

  it('leaves drill depths, feeds and pecking unchanged', () => {
    const drawing = drawingFor({ ...rectangle('drill'), circle: { center: { x: 50, y: 50 }, radius: 3.175 } })
    const result = generateCam(drawing, settings)
    const original = generateCam(drawing, { ...settings, rampProfile: undefined })
    expect(result.errors).toEqual([])
    expect(result.gcode.replace('Ramp 5 degrees F1200', 'Ramp 3 degrees F600')).toBe(original.gcode)
    expect(result.gcode).toContain('G01 Z-4.5 F600\nG00 Z20')
  })

  it('supports API conversion and sheet jobs without leaking ramp settings to other variants', async () => {
    const result = await generateDxfNc({ dxf, thicknessMm: 12, rampProfile: settings.rampProfile })
    const original = await generateDxfNc({ dxf, thicknessMm: 12 })
    expect(result.settings).toEqual({ ...original.settings, rampDegrees: 5, rampFeedMmPerMinute: 1200 })
    expect(result.filename).toBe('component-12mm-ramp20-5deg.nc')
    expect(result.materialVariants.primaryProfile).toBe('12-ramp20-5deg')
    expect(result.materialVariants.profiles).toEqual(original.materialVariants.profiles)
    expect(result.materialVariants.profiles['12-ramp20-5deg']?.gcode).toBe(result.gcode)
    expect(materialVariantsSchema.safeParse(result.materialVariants).success).toBe(true)
    const part = createPartFromGCode('panel.nc', original.gcode, dxf, testItem.id)
    part.metadata.materialVariants = result.materialVariants
    const request = parseJobRequest({ jobName: 'Ramp test', orderNumber: 'TEST', items: [{ itemId: testItem.id, quantity: 1 }], sheet: { widthMm: 500, heightMm: 400, material: 'Plywood', thicknessMm: 12, rampProfile: settings.rampProfile, screwMarks: false } })
    const job = await generateJob(request, [testItem], [part])
    expect(job.sheet.materialProfile).toBe('12-ramp20-5deg')
    expect(job.parts[0].originalFilename).toBe('panel-12mm-ramp20-5deg.nc')
    expect(job.exported[0].gcode).toContain('F1200')
    expect(simulateGCode(job.exported[0].gcode).deepestCutMm).toBe(12.2)
    const older = structuredClone(result.materialVariants)
    delete older.profiles['12-ramp20-5deg']
    older.primaryProfile = '12'
    expect(materialVariantsSchema.safeParse(older).success).toBe(true)
    part.metadata.materialVariants = older
    await expect(generateJob(request, [testItem], [part])).rejects.toThrow('unavailable')
  })

  it.each([{ thicknessMm: 18 }, { thicknessMm: 6 }, { profilePasses: 2 }, { drillDepthMm: 2 }, { rampProfile: 'unknown' }])('rejects incompatible API profile options %j', async patch => {
    await expect(generateDxfNc({ dxf, thicknessMm: 12, rampProfile: settings.rampProfile, ...patch })).rejects.toMatchObject({ status: 400 })
    expect(() => parseJobRequest({ jobName: 'Test', orderNumber: 'TEST', items: [{ itemId: testItem.id, quantity: 1 }], sheet: { widthMm: 500, heightMm: 400, material: 'Plywood', thicknessMm: 12, rampProfile: settings.rampProfile, ...patch } })).toThrow()
  })

  it('generates the new profile when not primary and respects requested variant limits', () => {
    const result = generateMaterialVariants(readDxf(dxf), { ...settings, rampProfile: undefined }, undefined, ['12', '12-ramp20-5deg'])
    expect(result.primaryProfile).toBe('12')
    expect(result.profiles['12-ramp20-5deg']?.gcode).toContain('Ramp 5 degrees F1200')
    expect(result.profiles['18'].gcode).toBe('')
  })
})
