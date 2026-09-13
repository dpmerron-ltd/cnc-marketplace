import type { PartInstance } from './PartInstance'

export interface GCodeSettings {
  startGcode: string
  endGcode: string
  safeZ: number
  maxDepthOfCut?: number
  xyFeedRate?: number
  applyXyFeedRate?: boolean
}

export interface GCodePreset {
  id: string
  name: string
  settings: GCodeSettings
}

export interface Sheet {
  width: number
  height: number
  spacing: number
  instances: PartInstance[]
  gcodeSettings: GCodeSettings
  gcodePresets?: GCodePreset[]
  defaultGcodePresetId?: string
}
