import type { PartInstance } from './PartInstance'

export interface GCodeSettings {
  startGcode: string
  endGcode: string
  safeZ: number
}

export interface Sheet {
  width: number
  height: number
  spacing: number
  instances: PartInstance[]
  gcodeSettings: GCodeSettings
}
