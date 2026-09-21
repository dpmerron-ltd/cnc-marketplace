import { z } from 'zod'
import { readDxf } from '../src/cam/dxf'
import { generateCam, materialPreset } from '../src/cam/generate'
import { camPreset, type CamDrawing, type OperationOverride } from '../src/cam/types'
import { JobError, sha256 } from '../src/jobs/generateJob'
import { defaultProgramSettings, spindleRpm, type ProgramSettings } from '../src/gcode/programSettings'
import { generateMaterialVariants } from '../src/cam/materialVariants'
import { materialProfileId, materialProfileSchema } from '../src/cam/materialProfiles'

export const dxfBodyLimit = 4 * 1024 * 1024
const override = z.strictObject({
  kind: z.enum(['outside', 'inside', 'drill', 'pocket', 'ignore', 'unassigned']).optional(),
  tabs: z.number().int().min(0).max(4).optional(),
  depthMm: z.number().positive().max(18.4).optional(),
  cornerOvercuts: z.boolean().optional(),
})
const overrides = z.record(z.string().min(1).max(160), override).refine(value => Object.keys(value).length <= 100, 'At most 100 operation overrides are allowed.').default({})
const schema = z.strictObject({
  dxf: z.string().min(1).max(2000000),
  thicknessMm: z.union([z.literal(6), z.literal(12), z.literal(15), z.literal(18)]),
  profilePasses: z.union([z.literal(1), z.literal(2)]).optional(),
  drillDepthMm: z.literal(9).optional(),
  variantProfiles: z.array(materialProfileSchema).min(1).max(6).refine(value => new Set(value).size === value.length, 'Use each profile once.').optional(),
  filename: z.string().max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*\.dxf$/i, 'Use a DXF filename without a directory.').default('component.dxf'),
  units: z.enum(['auto', 'mm', 'inches']).default('auto'),
  layerOperations: overrides,
  operations: overrides,
}).refine(value => value.profilePasses === undefined || value.thicknessMm === 12, { path: ['profilePasses'], message: 'Profile pass selection is only supported for 12 mm stock.' }).refine(value => value.drillDepthMm === undefined || value.thicknessMm === 18, { path: ['drillDepthMm'], message: 'The 9 mm drilling profile requires 18 mm stock.' }).refine(value => value.variantProfiles === undefined || value.variantProfiles.includes(materialProfileId(value.thicknessMm, value.profilePasses, value.drillDepthMm)!), { path: ['variantProfiles'], message: 'Requested variants must include the primary material profile.' })

export async function generateDxfNc(value: unknown, programs: ProgramSettings = defaultProgramSettings) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new JobError('Invalid DXF generation request.', 400, parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`))
  const input = parsed.data
  if (new TextEncoder().encode(input.dxf).length > 2000000) throw new JobError('DXF exceeds 2 MB.', 413)
  let drawing: CamDrawing
  try { drawing = readDxf(input.dxf, input.units) } catch (error) {
    throw new JobError('DXF could not be processed.', 422, [error instanceof Error ? error.message : 'Invalid DXF.'])
  }
  if (drawing.errors.length) throw new JobError('DXF geometry is invalid.', 422, drawing.errors)
  // The synchronous Edge endpoint has a smaller geometry budget than the browser worker.
  if (drawing.features.length > 100 || drawing.features.reduce((sum, feature) => sum + feature.points.length, 0) > 10000) {
    throw new JobError('API generation supports at most 100 features and 10,000 curve points. Split the drawing.', 422)
  }
  const ids = new Set(drawing.features.map(feature => feature.id))
  const layers = new Set(drawing.features.map(feature => feature.layer))
  const unknown = [...Object.keys(input.operations).filter(id => !ids.has(id)).map(id => `Unknown feature: ${id}`), ...Object.keys(input.layerOperations).filter(layer => !layers.has(layer)).map(layer => `Unknown layer: ${layer}`)]
  if (unknown.length) throw new JobError('Operation overrides do not match the DXF.', 400, unknown)
  const operations: Record<string, OperationOverride> = Object.create(null)
  for (const feature of drawing.features) {
    const layer = Object.hasOwn(input.layerOperations, feature.layer) ? input.layerOperations[feature.layer] : {}
    const specific = Object.hasOwn(input.operations, feature.id) ? input.operations[feature.id] : {}
    operations[feature.id] = { ...layer, ...specific }
    const effective = { ...feature, ...operations[feature.id] }
    if (operations[feature.id].depthMm !== undefined && effective.kind !== 'pocket') throw new JobError(`${feature.id}: depthMm is only supported for pockets; drill and profile depths use the material preset.`, 400)
    if (operations[feature.id].tabs !== undefined && !['inside', 'outside'].includes(effective.kind)) throw new JobError(`${feature.id}: tabs are only supported for inside/outside contours.`, 400)
    if (operations[feature.id].cornerOvercuts !== undefined && (!['inside', 'pocket'].includes(effective.kind) || effective.circle)) throw new JobError(`${feature.id}: cornerOvercuts is only supported for non-circular pockets and inside contours.`, 400)
  }
  const result = generateCam(drawing, { thickness: input.thicknessMm, profilePasses: input.profilePasses, drillDepthMm: input.drillDepthMm, units: input.units, operations, programs })
  if (result.errors.length) throw new JobError('DXF machining validation failed.', 422, result.errors)
  const bytes = new TextEncoder().encode(result.gcode).length
  if (result.gcode.split('\n').length > 20000 || bytes > 2000000) throw new JobError('Generated NC exceeds 20,000 lines or 2 MB. Split the drawing.', 422)
  const material = materialPreset(input.thicknessMm, input.profilePasses, input.drillDepthMm)
  const materialVariants = generateMaterialVariants(drawing, { thickness: input.thicknessMm, profilePasses: input.profilePasses, drillDepthMm: input.drillDepthMm, units: input.units, operations, programs }, result, input.variantProfiles)
  return {
    filename: input.filename.replace(/\.dxf$/i, input.drillDepthMm === 9 ? '-18mm-9mm-holes.nc' : input.profilePasses === 2 ? '-12mm-2pass.nc' : '.nc'),
    contentType: 'text/plain', bytes, sha256: await sha256(result.gcode), gcode: result.gcode,
    reviewRequired: true, materialVariants,
    programSettings: { ...programs },
    warnings: result.warnings,
    settings: {
      thicknessMm: input.thicknessMm, drawingUnits: (input.units === 'auto' ? drawing.units : input.units) === 'inches' ? 'inches' : 'mm',
      cutterDiameterMm: camPreset.diameter, spindleRpm: spindleRpm(programs), clearanceMm: camPreset.clearance,
      cutDepthMm: material.depth, passDepthsMm: material.passes, drillDepthMm: material.drill, drillPeckMm: 2, drillPeckRetractMm: 0.5,
      rampDegrees: camPreset.rampDegrees, rampFeedMmPerMinute: camPreset.rampFeed, cutFeedMmPerMinute: camPreset.cutFeed,
      reachCheck: false, screwMarking: false,
    },
    drawingShiftMm: result.shift,
    features: result.drawing.features.map(feature => ({ id: feature.id, name: feature.name, layer: feature.layer, kind: feature.kind, hinge: Boolean(feature.hinge), door: Boolean(feature.door), toolCentreline: Boolean(feature.toolCentreline) })),
    operations: result.operations.map(operation => ({ featureId: operation.featureId, name: operation.name, kind: operation.kind, depthMm: operation.depthMm, tabCount: operation.tabs.length, firstLine: operation.firstLine, lastLine: operation.lastLine })),
    summary: { bounds: result.simulation.bounds, deepestCutMm: result.simulation.deepestCutMm, operationCount: result.operations.length },
  }
}
