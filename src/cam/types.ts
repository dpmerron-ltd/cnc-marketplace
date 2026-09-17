import type { Point } from '../models/geometry'
import type { GCodeSimulation } from '../gcode/simulator'

export type OperationKind = 'outside' | 'inside' | 'drill' | 'pocket' | 'ignore' | 'unassigned'
export interface CamFeature {
  id: string
  name: string
  layer: string
  points: Point[]
  closed: boolean
  circle?: { center: Point; radius: number }
  kind: OperationKind
  depthMm?: number
}
export interface CamDrawing { features: CamFeature[]; warnings: string[]; errors: string[]; units: 'mm' | 'inches' | 'unknown' }
export interface OperationOverride { kind?: OperationKind; depthMm?: number; tabs?: number }
export interface CamSettings {
  thickness: 12 | 18
  units: 'auto' | 'mm' | 'inches'
  operations: Record<string, OperationOverride>
}
export interface CamOperation {
  featureId: string
  name: string
  kind: OperationKind
  path: Point[]
  tabs: Array<{ start: Point; end: Point; points: Point[] }>
  depthMm: number
  firstLine: number
  lastLine: number
}
export interface CamResult {
  drawing: CamDrawing
  operations: CamOperation[]
  gcode: string
  simulation: GCodeSimulation
  errors: string[]
  warnings: string[]
  shift: Point
}
export const camPreset = { diameter: 6.35, spindle: 18000, clearance: 20, rampDegrees: 3, rampFeed: 600, cutFeed: 3000, tabWidth: 10, tabHeight: 6 } as const
