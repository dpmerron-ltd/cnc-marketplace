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
const drawingFor = (feature: CamFeature): CamDrawing => ({ features: [feature], units: 'mm', warnings: [], errors: [] })
const dxf = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', 0, 'LWPOLYLINE', 8, 'PROFILE', 90, 4, 70, 1, 10, 0, 20, 0, 10, 180, 20, 0, 10, 180, 20, 100, 10, 0, 20, 100, 0, 'ENDSEC', 0, 'EOF', ''].join('\n')

describe.each([
  { thickness: 12 as const, drillDepthMm: undefined, drill: 4.5, depth: 12.2, id: '12-ramp20-5deg' as const, baseId: '12' as const, suffix: '12mm-ramp20-5deg', invalid: [{ thicknessMm: 18 }, { thicknessMm: 6 }, { profilePasses: 2 }, { drillDepthMm: 2 }, { rampProfile: 'unknown' }] },
  { thickness: 18 as const, drillDepthMm: 9 as const, drill: 9, depth: 18.4, id: '18-9mm-ramp20-5deg' as const, baseId: '18-9mm' as const, suffix: '18mm-9mm-holes-ramp20-5deg', invalid: [{ drillDepthMm: undefined }, { thicknessMm: 6 }, { profilePasses: 2 }, { drillDepthMm: 2 }, { rampProfile: 'unknown' }] },
])('$id ramp profile', profile => {
  const settings: CamSettings = { thickness: profile.thickness, drillDepthMm: profile.drillDepthMm, units: 'mm', operations: {}, rampProfile: '20mm-s-5deg' }
  it.each([
    rectangle('outside'), rectangle('inside'), rectangle('inside', 40, 6),
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
    expect(result.gcode).toContain(`G01 Z-${profile.drill} F600\nG00 Z20`)
  })

  it('supports API conversion and sheet jobs without leaking ramp settings to other variants', async () => {
    const result = await generateDxfNc({ dxf, thicknessMm: profile.thickness, drillDepthMm: profile.drillDepthMm, rampProfile: settings.rampProfile })
    const original = await generateDxfNc({ dxf, thicknessMm: profile.thickness, drillDepthMm: profile.drillDepthMm })
    expect(result.settings).toEqual({ ...original.settings, rampDegrees: 5, rampFeedMmPerMinute: 1200 })
    expect(result.settings.passDepthsMm).toEqual(profile.thickness === 18 ? [9.2, 18.4] : [12.2])
    expect(result.filename).toBe(`component-${profile.suffix}.nc`)
    expect(result.materialVariants.primaryProfile).toBe(profile.id)
    expect(result.materialVariants.profiles).toEqual(original.materialVariants.profiles)
    expect(result.materialVariants.profiles[profile.id]?.gcode).toBe(result.gcode)
    expect(materialVariantsSchema.safeParse(result.materialVariants).success).toBe(true)
    const part = createPartFromGCode('panel.nc', original.gcode, dxf, testItem.id)
    part.metadata.materialVariants = result.materialVariants
    const request = parseJobRequest({ jobName: 'Ramp test', orderNumber: 'TEST', items: [{ itemId: testItem.id, quantity: 1 }], sheet: { widthMm: 500, heightMm: 400, material: 'Plywood', thicknessMm: profile.thickness, drillDepthMm: profile.drillDepthMm, rampProfile: settings.rampProfile, screwMarks: false } })
    const job = await generateJob(request, [testItem], [part])
    expect(job.sheet.materialProfile).toBe(profile.id)
    expect(job.parts[0].originalFilename).toBe(`panel-${profile.suffix}.nc`)
    expect(job.exported[0].gcode).toContain('F1200')
    expect(simulateGCode(job.exported[0].gcode).deepestCutMm).toBe(profile.depth)
    const older = structuredClone(result.materialVariants)
    delete older.profiles[profile.id]
    older.primaryProfile = profile.baseId
    expect(materialVariantsSchema.safeParse(older).success).toBe(true)
    expect(materialVariantsSchema.safeParse({ ...older, primaryProfile: profile.id }).success).toBe(false)
    part.metadata.materialVariants = older
    await expect(generateJob(request, [testItem], [part])).rejects.toThrow('unavailable')
  })

  it.each(profile.invalid)('rejects incompatible API profile options %j', async patch => {
    await expect(generateDxfNc({ dxf, thicknessMm: profile.thickness, drillDepthMm: profile.drillDepthMm, rampProfile: settings.rampProfile, ...patch })).rejects.toMatchObject({ status: 400 })
    expect(() => parseJobRequest({ jobName: 'Test', orderNumber: 'TEST', items: [{ itemId: testItem.id, quantity: 1 }], sheet: { widthMm: 500, heightMm: 400, material: 'Plywood', thicknessMm: profile.thickness, drillDepthMm: profile.drillDepthMm, rampProfile: settings.rampProfile, ...patch } })).toThrow()
  })

  it('generates the new profile when not primary and respects requested variant limits', () => {
    const result = generateMaterialVariants(readDxf(dxf), { ...settings, rampProfile: undefined }, undefined, [profile.baseId, profile.id])
    expect(result.primaryProfile).toBe(profile.baseId)
    expect(result.profiles[profile.id]?.gcode).toContain('Ramp 5 degrees F1200')
    expect(result.profiles['18'].gcode).toBe('')
  })
})

it('keeps 18 mm hinge pockets at 12 mm and 9 mm drills in the new ramp profile', () => {
  const settings: CamSettings = { thickness: 18, drillDepthMm: 9, rampProfile: '20mm-s-5deg', units: 'mm', operations: {} }
  const hinge = { ...rectangle('pocket'), hinge: true, depthMm: 12, circle: { center: { x: 50, y: 50 }, radius: 17.5 } }
  const result = generateCam(drawingFor(hinge), settings)
  expect(result.errors).toEqual([])
  expect(result.operations[0].depthMm).toBe(12)
  expect(result.simulation.deepestCutMm).toBe(12)
  const drill = generateCam(drawingFor({ ...rectangle('drill'), circle: { center: { x: 50, y: 50 }, radius: 3.175 } }), settings)
  expect(drill.errors).toEqual([])
  for (const depth of [2, 4, 6, 8, 9]) expect(drill.gcode).toContain(`G01 Z-${depth} F600\nG00 Z${depth === 9 ? 20 : 0.5}`)
  expect(drill.gcode).not.toContain('Z-9.2')
})
