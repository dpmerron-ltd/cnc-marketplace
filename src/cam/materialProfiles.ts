import { z } from 'zod'

export const materialProfiles = [
  { id: '6', label: '6 mm', thickness: 6, profilePasses: 1, drillDepthMm: undefined },
  { id: '12', label: '12 mm (1 pass)', thickness: 12, profilePasses: 1, drillDepthMm: undefined },
  { id: '12-2mm', label: '12 mm (1 pass, 2 mm drills)', thickness: 12, profilePasses: 1, drillDepthMm: 2 },
  { id: '12-2pass', label: '12 mm (2 passes)', thickness: 12, profilePasses: 2, drillDepthMm: undefined },
  { id: '15', label: '15 mm', thickness: 15, profilePasses: 2, drillDepthMm: undefined },
  { id: '18', label: '18 mm', thickness: 18, profilePasses: 2, drillDepthMm: undefined },
  { id: '18-9mm', label: '18 mm (9 mm holes)', thickness: 18, profilePasses: 2, drillDepthMm: 9 },
] as const
export type MaterialProfileId = typeof materialProfiles[number]['id']
export const materialProfileSchema = z.enum(['6', '12', '12-2mm', '12-2pass', '15', '18', '18-9mm'])
const variantSchema = z.strictObject({
  gcode: z.string().max(2000000), warnings: z.array(z.string()), errors: z.array(z.string()),
}).refine(value => value.errors.length ? !value.gcode : Boolean(value.gcode), 'A variant must contain either valid G-code or blocking errors.')
export const materialVariantsSchema = z.strictObject({
  version: z.literal(1), primaryProfile: materialProfileSchema,
  // Older bundles remain valid; missing profiles are never fabricated.
  profiles: z.strictObject({ '6': variantSchema, '12': variantSchema, '12-2pass': variantSchema, '15': variantSchema, '18': variantSchema, '18-9mm': variantSchema.optional(), '12-2mm': variantSchema.optional() }),
}).refine(value => Boolean(value.profiles[value.primaryProfile]), 'Primary material profile must be present.')
export type MaterialVariants = z.infer<typeof materialVariantsSchema>
export function materialProfileId(thickness: number, profilePasses?: number, drillDepthMm?: number): MaterialProfileId | undefined {
  return materialProfiles.find(profile => profile.thickness === thickness && profile.drillDepthMm === drillDepthMm && (thickness !== 12 || profile.profilePasses === (profilePasses ?? 1)))?.id
}
