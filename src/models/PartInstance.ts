import type { Rotation } from './geometry'

export interface PartInstance {
  id: string
  partId: string
  partNumber?: number
  sheetIndex: number
  x: number
  y: number
  rotation: Rotation
  locked: boolean
}
