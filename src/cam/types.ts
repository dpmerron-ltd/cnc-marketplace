import type { Point } from '../models/geometry'
import type { GCodeSimulation } from '../gcode/simulator'
import type { ProgramSettings } from '../gcode/programSettings'

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
  hinge?: boolean
  door?: boolean
}
export interface CamDrawing { features: CamFeature[]; warnings: string[]; errors: string[]; units: 'mm' | 'inches' | 'unknown' }
export interface OperationOverride { kind?: OperationKind; depthMm?: number; tabs?: number; cornerOvercuts?: boolean }
export interface CamSettings {
  thickness: 12 | 15 | 18
  units: 'auto' | 'mm' | 'inches'
  operations: Record<string, OperationOverride>
  programs?: ProgramSettings
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
type TabFeature = Pick<CamFeature, 'kind' | 'layer' | 'door' | 'circle' | 'points'>
// Feature coordinates must be in millimetres, before cutter compensation.
export function requiresHoldingTabs(feature: TabFeature): boolean {
  if (feature.kind !== 'inside' && feature.kind !== 'outside') return false
  if (feature.door || /DOOR/i.test(feature.layer)) return true
  const xs = feature.points.map(p => p.x), ys = feature.points.map(p => p.y)
  const span = feature.circle ? feature.circle.radius * 2 : Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  return span > 12 + 1e-6
}
export const defaultTabCount = (feature: TabFeature) => requiresHoldingTabs(feature) ? 4 : 0
