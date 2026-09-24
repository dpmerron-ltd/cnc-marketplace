import { z } from 'zod'
import { autoNest, partFitsSheet } from '../nesting/nestingEngine'
import { buildPartLabels, numberSheetParts } from '../labels/partLabels'
import { validateSheet } from '../gcode/validator'
import { exportPhysicalSheetGCodes } from '../gcode/exporter'
import { simulateGCode } from '../gcode/simulator'
import { originalFinalDepth } from '../gcode/depth'
import { instanceBounds } from '../gcode/transform'
import { preparationBounds } from '../gcode/preparationBounds'
import { planScrewPositions } from '../gcode/screwPositions'
import { defaultProgramSettings, spindleRpm, type ProgramSettings } from '../gcode/programSettings'
import type { Sheet } from '../models/Sheet'
import type { Part } from '../models/Part'
import type { MarketplaceItem } from '../models/Item'
import type { JobManifest, JobRequest } from './types'
import { materialProfileId } from '../cam/materialProfiles'
import { selectMaterialParts } from '../gcode/materialSelection'

export class JobError extends Error {
  status: number
  details: string[]
  constructor(message: string, status = 422, details: string[] = []) { super(message); this.status = status; this.details = details }
}
const text = (max: number) => z.string().trim().min(1).max(max)
export const jobRequestSchema = z.strictObject({
  jobName: text(160), orderNumber: text(100), notes: z.string().trim().max(2000).default(''),
  items: z.array(z.strictObject({ itemId: z.uuid().optional(), sku: text(100).optional(), quantity: z.number().int().min(1).max(20) }).refine(value => Boolean(value.itemId) !== Boolean(value.sku), 'Supply either itemId or sku, not both.')).min(1).max(20),
  sheet: z.strictObject({
    widthMm: z.number().min(50).max(10000), heightMm: z.number().min(50).max(10000), material: text(160), thicknessMm: z.union([z.literal(6), z.literal(12), z.literal(15), z.literal(18)]).optional(), profilePasses: z.union([z.literal(1), z.literal(2)]).optional(), drillDepthMm: z.union([z.literal(2), z.literal(9)]).optional(),
    spacingMm: z.number().min(0).max(100).default(30), borderMm: z.number().min(0).max(200).default(10), safeZMm: z.number().min(0.5).max(200).default(20), screwMarks: z.boolean().default(true),
  }).refine(value => value.borderMm * 2 < Math.min(value.widthMm, value.heightMm), 'Border must leave usable sheet area.').refine(value => value.profilePasses === undefined || value.thicknessMm === 12, 'Profile pass selection requires 12 mm stock.').refine(value => value.drillDepthMm === undefined || (value.thicknessMm !== undefined && materialProfileId(value.thicknessMm, value.profilePasses, value.drillDepthMm) !== undefined), 'Use 12 mm stock and 1 pass for 2 mm drills, or 18 mm stock for 9 mm drills.'),
  labels: z.strictObject({ widthMm: z.number().min(40).max(190).default(50), heightMm: z.number().min(20).max(277).default(25) }).default({ widthMm: 50, heightMm: 25 }),
})

export function parseJobRequest(value: unknown): JobRequest {
  const parsed = jobRequestSchema.safeParse(value)
  if (!parsed.success) throw new JobError('Invalid job request.', 400, parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`))
  return parsed.data
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function generateJob(request: JobRequest, catalog: MarketplaceItem[], components: Part[], programs: ProgramSettings = defaultProgramSettings) {
  const counts = new Map<string, number>()
  for (const line of request.items) {
    const matches = catalog.filter(item => line.itemId ? item.id === line.itemId : item.sku === line.sku)
    if (matches.length !== 1) throw new JobError(`Item ${line.itemId ?? line.sku} is missing or its SKU is ambiguous in the shared catalogue.`)
    counts.set(matches[0].id, (counts.get(matches[0].id) ?? 0) + line.quantity)
  }
  const items = catalog.filter(item => counts.has(item.id))
  const sourceParts = components.filter(part => counts.has(part.itemId ?? '')).sort((a, b) => a.id.localeCompare(b.id))
  const materialProfile = request.sheet.thicknessMm === undefined ? undefined : materialProfileId(request.sheet.thicknessMm, request.sheet.profilePasses, request.sheet.drillDepthMm)
  const selection = selectMaterialParts(sourceParts, { materialProfile, instances: sourceParts.map(part => ({ partId: part.id })) })
  if (selection.errors.length) throw new JobError('The selected sheet thickness is unavailable for one or more components.', 422, selection.errors)
  const parts = selection.parts
  if (parts.reduce((sum, part) => sum + part.gcode.length, 0) > 2000000) throw new JobError('Selected component programs exceed 2 MB. Split the order into smaller jobs.')
  const manifestItems = items.map(item => {
    const componentsPerItem = parts.filter(part => part.itemId === item.id).length
    if (!componentsPerItem) throw new JobError(`${item.name} has no components.`)
    return { id: item.id, sku: item.sku, name: item.name, quantity: counts.get(item.id)!, componentsPerItem }
  })
  const partCount = manifestItems.reduce((sum, item) => sum + item.quantity * item.componentsPerItem, 0)
  if (partCount > 20) throw new JobError('A job can contain at most 20 placed components. Split this order into smaller jobs.')
  const sourceLines = parts.reduce((sum, part) => sum + part.parsed.lines.length * counts.get(part.itemId!)!, 0)
  if (sourceLines > 5000) throw new JobError('Expanded machining programs exceed 5,000 lines. Split this order into smaller jobs.')
  const settings = request.sheet
  let sheet: Sheet = {
    name: request.jobName, orderNumber: request.orderNumber, material: settings.material, materialProfile,
    width: settings.widthMm, height: settings.heightMm, spacing: settings.spacingMm, borderSpacing: settings.borderMm,
    safeZOverrideMm: settings.safeZMm, screwMarkingEnabled: settings.screwMarks,
    gcodeSettings: { ...programs, safeZ: settings.safeZMm },
    instances: [],
  }
  for (const part of parts) {
    if (![part.width, part.height].every(value => Number.isFinite(value) && value > 0)) throw new JobError(`${part.name} has no finite, nestable machining footprint.`)
    if (!partFitsSheet(part, sheet)) throw new JobError(`${part.name} cannot fit on the requested sheet in any supported nesting orientation.`)
    for (let copy = 0; copy < counts.get(part.itemId!)!; copy++) sheet.instances.push({ id: crypto.randomUUID(), partId: part.id, sheetIndex: 0, x: settings.borderMm, y: settings.borderMm, rotation: 0, locked: false })
  }
  sheet = numberSheetParts(sheet)
  sheet.instances = autoNest(parts, sheet)
  const issues = validateSheet(parts, sheet)
  const exported = exportPhysicalSheetGCodes(parts, sheet, programs)
  const simulations = exported.map(result => simulateGCode(result.gcode))
  const errors = [...issues.filter(issue => issue.level === 'error').map(issue => issue.message), ...exported.flatMap(file => file.errors), ...simulations.flatMap(simulation => simulation.errors)]
  if (errors.length) throw new JobError('The job failed machining validation and has not been queued.', 422, [...new Set(errors)])
  const warnings = [...new Set([...issues.filter(issue => issue.level === 'warning').map(issue => issue.message), ...exported.flatMap(file => file.warnings), ...simulations.flatMap((simulation, i) => simulation.warnings.map(warning => `Sheet ${i + 1}: ${warning}`))])]
  const labels = buildPartLabels(parts, items, sheet)
  const cuts = labels.map(label => {
    const instance = sheet.instances.find(instance => instance.id === label.instanceId)!
    const part = parts.find(part => part.id === instance.partId)!
    return { ...label, partId: part.id, widthMm: part.width, heightMm: part.height, bounds: instanceBounds(part, instance), deepestCutMm: originalFinalDepth(part) ?? 0, sourceFilename: part.originalFilename }
  })
  if (settings.thicknessMm && cuts.some(cut => cut.deepestCutMm > settings.thicknessMm! + 1)) warnings.push('Some source cuts exceed the stated material thickness by more than 1 mm. Verify the stock, work zero and spoilboard allowance.')
  const manifest: JobManifest = {
    version: 1, request, items: manifestItems, cuts, programSettings: { ...programs },
    sheets: exported.map((file, i) => {
      const instances = sheet.instances.filter(instance => instance.sheetIndex === i)
      const bounds = instances.map(instance => preparationBounds(parts.find(part => part.id === instance.partId)!, instance, settings.safeZMm).bounds)
      return { number: i + 1, partCount: instances.length, maxX: Math.max(...bounds.map(bounds => bounds.maxX)), maxY: Math.max(...bounds.map(bounds => bounds.maxY)), deepestCutMm: simulations[i].deepestCutMm, estimatedSeconds: simulations[i].estimatedSeconds, screwMarks: planScrewPositions(parts, sheet, file.sheetIndex).points.length }
    }),
    warnings,
    setup: [
      'Generated for operator review. Queue status changes do not start or control the CNC.',
      'Verify stock, cutter, work origin, hold-downs, grain direction and clearances before approving. Automatic nesting may rotate parts.',
      `Millimetres; absolute coordinates; Z0 at material surface; safe Z ${settings.safeZMm} mm.`,
      `Account program settings applied; ${programs.spindleStartGcode.trim() ? `spindle start S${spindleRpm(programs)} M03` : 'manual cutter control, no automatic spindle start'}. Source machining feeds and cutting depths are preserved. Verify tool, startup/end programs and controller start-up delay.`,
      'Maximum X/Y reach check precedes each sheet. Confirm the physical machine can reach these coordinates. M05 only stops automatically controlled spindles.',
      settings.screwMarks ? 'Screw marking enabled: 6 mm cutter, recessed screws, 2 mm marking depth, followed by M05 / M00 pause to fit screws.' : 'Screw marking is disabled. Secure the material before starting.',
      'Load each physical sheet separately, align its origin and use its matching sheet-N.nc file. Apply labels only with the machine and spindle stopped.',
      'Dimensions are source toolpath footprints, not finished-part dimensions. Layout drawings are not to scale. Timing excludes manual setup and pauses.',
    ],
    sources: await Promise.all(parts.map(async part => ({ id: part.id, filename: part.originalFilename, sha256: await sha256(part.gcode), feeds: [...new Set(part.parsed.lines.flatMap(line => line.words.filter(word => word.letter === 'F').map(word => word.value)))], spindleSpeeds: [...new Set(part.parsed.lines.flatMap(line => line.words.filter(word => word.letter === 'S').map(word => word.value)))] }))),
  }
  return { manifest, sheet, parts, exported, simulations }
}
