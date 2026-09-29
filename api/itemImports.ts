import { z } from 'zod'
import { createItemSchema } from './items'
import { componentInputSchema, parseComponent } from './components'
import { materialProfiles, materialProfileSchema } from '../src/cam/materialProfiles'
import { materialPreset } from '../src/cam/generate'
import { simulateGCode } from '../src/gcode/simulator'
import { JobError } from '../src/jobs/generateJob'
import type { DocumentUpload } from './documents'

const ids = (max: number) => z.array(z.uuid()).max(max).refine(value => new Set(value).size === value.length, 'IDs must be unique.')
export const itemImportSchema = z.strictObject({
  id: z.uuid(), expectedVersionId: z.uuid(),
  item: createItemSchema.omit({ id: true }).extend({ image: createItemSchema.shape.image.unwrap().nullable() }),
  componentIds: ids(100).min(1), documentIds: ids(20),
})
export type ItemImportInput = z.infer<typeof itemImportSchema>
export interface ItemImportStatus {
  id: string; expectedVersionId: string; publishedItemId: string | null
  componentIds: string[]; documentIds: string[]; staged: { kind: string; key: string }[]
}
export interface ItemImportRepository {
  beginItemImport(owner: string, item: string, input: ItemImportInput): Promise<ItemImportStatus>
  itemImport(owner: string, item: string, id: string): Promise<ItemImportStatus>
  stageItemImport(owner: string, item: string, id: string, kind: 'component' | 'profile', key: string, payload: unknown): Promise<ItemImportStatus>
  stageImportDocument(owner: string, item: string, id: string, input: DocumentUpload): Promise<ItemImportStatus>
  publishItemImport(owner: string, item: string, id: string): Promise<ItemImportStatus>
}
const componentSchema = componentInputSchema.omit({ materialVariants: true }).extend({ primaryProfile: materialProfileSchema })
const profileSchema = z.strictObject({
  componentId: z.uuid(), profileId: materialProfileSchema,
  gcode: z.string().max(2000000), warnings: z.array(z.string().max(2000)).max(2000), errors: z.array(z.string().max(2000)).max(2000),
}).refine(value => value.errors.length ? !value.gcode : Boolean(value.gcode), 'Supply NC or blocking errors, never both.')

export function parseImportComponent(value: unknown, owner: string, item: string) {
  const input = componentSchema.safeParse(value)
  if (!input.success) throw new JobError('Invalid import component. Include primaryProfile; upload variants separately.', 400)
  const { primaryProfile, ...content } = input.data
  const { part } = parseComponent(content, owner, item)
  checkDepth(primaryProfile, part.gcode)
  return {
    id: part.id, name: part.name, sku: part.sku, original_filename: part.originalFilename,
    gcode: part.gcode, dxf: part.dxf ?? null, primaryProfile,
    width: part.width, height: part.height, bounding_box: part.boundingBox,
    original_bounds: part.originalBounds, metadata: part.metadata,
  }
}
function checkDepth(id: string, gcode: string) {
  const profile = materialProfiles.find(p => p.id === id)!
  if (simulateGCode(gcode).deepestCutMm > materialPreset(profile.thickness, profile.thickness === 12 ? profile.profilePasses : undefined, profile.drillDepthMm, profile.rampProfile).depth + 0.001) {
    throw new JobError(`${profile.label} variant cuts deeper than its material preset.`, 422)
  }
}
export function parseImportProfile(value: unknown, owner: string, item: string) {
  const input = profileSchema.safeParse(value)
  if (!input.success) throw new JobError('Invalid import profile. Supply componentId, profileId, gcode, warnings and errors.', 400)
  if (input.data.gcode) {
    parseComponent({ id: input.data.componentId, name: 'Profile', sku: 'PROFILE', filename: 'profile.nc', gcode: input.data.gcode }, owner, item)
    checkDepth(input.data.profileId, input.data.gcode)
  }
  return input.data
}
