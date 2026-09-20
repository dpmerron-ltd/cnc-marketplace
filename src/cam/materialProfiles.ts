import { z } from 'zod'

export const materialProfiles = [
  { id: '6', label: '6 mm', thickness: 6, profilePasses: 1 },
  { id: '12', label: '12 mm (1 pass)', thickness: 12, profilePasses: 1 },
  { id: '12-2pass', label: '12 mm (2 passes)', thickness: 12, profilePasses: 2 },
  { id: '15', label: '15 mm', thickness: 15, profilePasses: 2 },
  { id: '18', label: '18 mm', thickness: 18, profilePasses: 2 },
] as const
export type MaterialProfileId = typeof materialProfiles[number]['id']
export const materialProfileSchema = z.enum(['6', '12', '12-2pass', '15', '18'])
const variantSchema = z.strictObject({
  gcode: z.string().max(2000000), warnings: z.array(z.string()), errors: z.array(z.string()),
}).refine(value => value.errors.length ? !value.gcode : Boolean(value.gcode), 'A variant must contain either valid G-code or blocking errors.')
export const materialVariantsSchema = z.strictObject({
  version: z.literal(1), primaryProfile: materialProfileSchema,
  profiles: z.record(materialProfileSchema, variantSchema),
})
export type MaterialVariants = z.infer<typeof materialVariantsSchema>
export function materialProfileId(thickness: number, profilePasses?: number): MaterialProfileId | undefined {
  return materialProfiles.find(profile => profile.thickness === thickness && (thickness !== 12 || profile.profilePasses === (profilePasses ?? 1)))?.id
}
