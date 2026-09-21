import { generateCam } from './generate'
import { materialProfileId, materialProfiles, type MaterialProfileId, type MaterialVariants } from './materialProfiles'
import type { CamDrawing, CamResult, CamSettings } from './types'

export function generateMaterialVariants(drawing: CamDrawing, settings: CamSettings, primaryResult?: CamResult, selectedProfiles?: readonly MaterialProfileId[]): MaterialVariants {
  const primaryProfile = materialProfileId(settings.thickness, settings.profilePasses, settings.drillDepthMm)!
  const profiles = {} as MaterialVariants['profiles']
  for (const profile of materialProfiles) {
    if (selectedProfiles && !selectedProfiles.includes(profile.id)) {
      profiles[profile.id] = { gcode: '', errors: ['Not generated for this request. Regenerate from DXF to use this profile.'], warnings: [] }
      continue
    }
    try {
      const result = profile.id === primaryProfile && primaryResult ? primaryResult : generateCam(drawing, {
        ...settings, drillDepthMm: profile.id === '18-9mm' ? 9 : undefined, thickness: profile.thickness, profilePasses: profile.thickness === 12 ? profile.profilePasses : undefined,
      })
      const errors = [...result.errors]
      if (result.gcode.split('\n').length > 20000 || new TextEncoder().encode(result.gcode).length > 2000000) errors.push('Generated NC exceeds 20,000 lines or 2 MB. Split the drawing.')
      profiles[profile.id] = { gcode: errors.length ? '' : result.gcode, errors, warnings: result.warnings }
    } catch (error) {
      profiles[profile.id] = { gcode: '', errors: [error instanceof Error ? error.message : 'Generation failed.'], warnings: [] }
    }
  }
  return { version: 1, primaryProfile, profiles }
}
