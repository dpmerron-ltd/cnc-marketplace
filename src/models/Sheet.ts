import type { PartInstance } from './PartInstance'
import type { MaterialProfileId } from '../cam/materialProfiles'

export interface GCodeSettings {
  startGcode: string
  spindleStartGcode: string
  endGcode: string
  safeZ: number
}

export interface GCodePreset {
  id: string
  ownerId?: string
  uploadedBy?: string
  name: string
  settings: GCodeSettings
}

export interface Sheet {
  name: string
  orderNumber?: string
  orderImports?: { key: string; name: string; instanceIds: string[] }[]
  material?: string
  materialProfile?: MaterialProfileId
  nextPartNumber?: number
  width: number
  height: number
  spacing: number
  borderSpacing: number
  instances: PartInstance[]
  screwMarkingEnabled?: boolean
  // null records an explicitly disabled override; absent values use the app default.
  safeZOverrideMm?: number | null
  gcodeSettings: GCodeSettings
  gcodePresets?: GCodePreset[]
  defaultGcodePresetId?: string
}
