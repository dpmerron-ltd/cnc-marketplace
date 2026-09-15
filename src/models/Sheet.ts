import type { PartInstance } from './PartInstance'

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
  width: number
  height: number
  spacing: number
  borderSpacing: number
  instances: PartInstance[]
  screwMarkingEnabled?: boolean
  gcodeSettings: GCodeSettings
  gcodePresets?: GCodePreset[]
  defaultGcodePresetId?: string
}
