export interface PackingSize { length: number; width: number; height: number }
export interface PackingComponentSettings { widthMm?: number; heightMm?: number; thicknessMm?: number }
export interface PackingSettings {
  paddingMm?: number
  separatorMm?: number
  wallMm?: number
  components?: Record<string, PackingComponentSettings>
}
export interface PackingPiece {
  id: string; name: string; width: number; height: number; thickness: number
  thicknessSource: 'entered' | 'material hint' | 'assumed'
  footprintSource: 'entered' | 'toolpath'
}
export interface PackingPlacement { id: string; x: number; y: number; width: number; height: number; rotated: boolean }
export interface PackingLayer { height: number; z: number; parts: PackingPlacement[] }
export interface PackingPlan {
  internal: PackingSize; external: PackingSize; rangeMax: PackingSize
  volumeLitres: number; layers: PackingLayer[]
  stockId?: string; stockName?: string; stockQuantity?: number; stockInternal?: PackingSize
}
export interface PackingEstimate {
  pieces: PackingPiece[]; boxes: PackingPlan[]; errors: string[]; warnings: string[]
  settings: { paddingMm: number; separatorMm: number; wallMm: number }
  candidates: number
  suggestedBox?: PackingPlan
}
