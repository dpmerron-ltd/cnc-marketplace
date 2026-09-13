import type { PartInstance } from './PartInstance'

export interface GCodeSettings {
  startGcode: string
  spindleStartGcode: string
  endGcode: string
  safeZ: number
  maxDepthOfCut?: number
  xyFeedRateMmPerSecond?: number
  xyFeedRate?: number
  applyXyFeedRate?: boolean
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
  gcodeSettings: GCodeSettings
  gcodePresets?: GCodePreset[]
  defaultGcodePresetId?: string
}
