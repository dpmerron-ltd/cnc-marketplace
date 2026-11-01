import type { Rotation } from './geometry'
import type { SheetMaterial } from './stockMaterial'

export interface PartInstance {
  orderKey?: string
  materialSetup?: SheetMaterial
  id: string
  recutId?: string
  orderName?: string
  partId: string
  partNumber?: number
  sheetIndex: number
  x: number
  y: number
  rotation: Rotation
  locked: boolean
}
