import type { Bounds, Point } from '../models/geometry'

export type MotionCommand = 'G00' | 'G01' | 'G02' | 'G03'
export type DistanceMode = 'absolute' | 'incremental'
export type Units = 'mm' | 'inch'

export interface GCodeWord {
  letter: string
  value: number
  raw: string
}

export interface ParsedLine {
  lineNumber: number
  raw: string
  words: GCodeWord[]
  comment?: string
  command?: string
  effectiveMotion?: MotionCommand
  warnings: string[]
  unsupportedForTransform?: string
}

export interface ParsedProgram {
  lines: ParsedLine[]
  warnings: string[]
  units: Units | 'unknown'
  distanceMode: DistanceMode | 'unknown'
  startLines: ParsedLine[]
  bodyLines: ParsedLine[]
  endLines: ParsedLine[]
}

export interface MachineState {
  units: Units
  distanceMode: DistanceMode
  plane: 'G17' | 'other'
  motion?: MotionCommand
  position: { x: number; y: number; z: number }
}

export interface ToolpathSegment {
  type: 'rapid' | 'cut' | 'arc-cw' | 'arc-ccw' | 'drill' | 'transition'
  start: Point
  end: Point
  center?: Point
  bounds: Bounds
  lineNumber?: number
  instanceId?: string
  partId?: string
}
