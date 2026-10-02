import { z } from 'zod'

export const rampProfileSchema = z.enum(['20mm-s-5deg', '10mm-s-5deg'])
export type RampProfile = z.infer<typeof rampProfileSchema>
export const materialProfiles = [
  { id: '6', label: '6 mm', thickness: 6, profilePasses: 1, drillDepthMm: undefined, rampProfile: undefined },
  { id: '12', label: '12 mm (1 pass)', thickness: 12, profilePasses: 1, drillDepthMm: undefined, rampProfile: undefined },
  { id: '12-ramp20-5deg', label: '12 mm (1 pass, ramp 20 mm/s at 5 deg)', thickness: 12, profilePasses: 1, drillDepthMm: undefined, rampProfile: '20mm-s-5deg' },
  { id: '12-2mm', label: '12 mm (1 pass, 2 mm drills)', thickness: 12, profilePasses: 1, drillDepthMm: 2, rampProfile: undefined },
  { id: '12-2pass', label: '12 mm (2 passes)', thickness: 12, profilePasses: 2, drillDepthMm: undefined, rampProfile: undefined },
  { id: '12-2pass-2mm-depth12p4', label: '12 mm (2 x 6.2 mm, 2 mm drills)', thickness: 12, profilePasses: 2, drillDepthMm: 2, rampProfile: undefined },
  { id: '12-2pass-2mm-ramp20-5deg', label: '12 mm (2 passes, 2 mm drills, ramp 20 mm/s at 5 deg)', thickness: 12, profilePasses: 2, drillDepthMm: 2, rampProfile: '20mm-s-5deg' },
  { id: '12-3pass-2mm-feed60-ramp20-5deg', label: '12 mm (3 passes, 60 mm/s, 2 mm drills, ramp 20 mm/s at 5 deg)', thickness: 12, profilePasses: 3, drillDepthMm: 2, rampProfile: '20mm-s-5deg' },
  { id: '14-4pass-2mm-ramp10-5deg', label: '14 mm (4 x 3.6 mm, 2 mm drills, ramp 10 mm/s at 5 deg)', thickness: 14, profilePasses: 4, drillDepthMm: 2, rampProfile: '10mm-s-5deg' },
  { id: '15', label: '15 mm', thickness: 15, profilePasses: 2, drillDepthMm: undefined, rampProfile: undefined },
  { id: '18', label: '18 mm', thickness: 18, profilePasses: 2, drillDepthMm: undefined, rampProfile: undefined },
  { id: '18-9mm', label: '18 mm (9 mm holes)', thickness: 18, profilePasses: 2, drillDepthMm: 9, rampProfile: undefined },
  { id: '18-9mm-ramp20-5deg', label: '18 mm (9 mm holes, ramp 20 mm/s at 5 deg)', thickness: 18, profilePasses: 2, drillDepthMm: 9, rampProfile: '20mm-s-5deg' },
] as const
export function rampPreset(profile?: RampProfile) {
  return profile === '20mm-s-5deg' ? { rampDegrees: 5, rampFeed: 1200 } : profile === '10mm-s-5deg' ? { rampDegrees: 5, rampFeed: 600 } : { rampDegrees: 3, rampFeed: 600 }
}
export type MaterialProfileId = typeof materialProfiles[number]['id']
export const materialProfileSchema = z.enum(['6', '12', '12-2mm', '12-2pass', '15', '18', '18-9mm', '12-ramp20-5deg', '18-9mm-ramp20-5deg', '12-2pass-2mm-ramp20-5deg', '12-3pass-2mm-feed60-ramp20-5deg', '12-2pass-2mm-depth12p4', '14-4pass-2mm-ramp10-5deg'])
export const cutFeedPreset = (profile?: MaterialProfileId) => profile === '12-3pass-2mm-feed60-ramp20-5deg' ? 3600 : 3000
const variantSchema = z.strictObject({
  gcode: z.string().max(2000000), warnings: z.array(z.string()), errors: z.array(z.string()),
}).refine(value => value.errors.length ? !value.gcode : Boolean(value.gcode), 'A variant must contain either valid G-code or blocking errors.')
export const materialVariantsSchema = z.strictObject({
  version: z.literal(1), primaryProfile: materialProfileSchema,
  // Older bundles remain valid; missing profiles are never fabricated.
  profiles: z.strictObject({ '6': variantSchema, '12': variantSchema, '12-2pass': variantSchema, '15': variantSchema, '18': variantSchema, '18-9mm': variantSchema.optional(), '12-2mm': variantSchema.optional(), '12-ramp20-5deg': variantSchema.optional(), '18-9mm-ramp20-5deg': variantSchema.optional(), '12-2pass-2mm-ramp20-5deg': variantSchema.optional(), '12-3pass-2mm-feed60-ramp20-5deg': variantSchema.optional(), '12-2pass-2mm-depth12p4': variantSchema.optional(), '14-4pass-2mm-ramp10-5deg': variantSchema.optional() }),
}).refine(value => Boolean(value.profiles[value.primaryProfile]), 'Primary material profile must be present.')
export type MaterialVariants = z.infer<typeof materialVariantsSchema>
export function materialProfileId(thickness: number, profilePasses?: number, drillDepthMm?: number, rampProfile?: RampProfile): MaterialProfileId | undefined {
  return materialProfiles.find(profile => profile.thickness === thickness && profile.drillDepthMm === drillDepthMm && profile.rampProfile === rampProfile && (![12, 14].includes(thickness) || profile.profilePasses === (profilePasses ?? 1)))?.id
}

export function validProfilePassSelection(thickness: number | undefined, passes?: number, drillDepthMm?: number, rampProfile?: RampProfile): boolean {
  if (thickness === 14) return materialProfileId(thickness, passes, drillDepthMm, rampProfile) !== undefined
  if (passes === undefined) return true
  return thickness === 12 && [1, 2, 3].includes(passes) && (passes !== 3 || materialProfileId(thickness, passes, drillDepthMm, rampProfile) !== undefined)
}
