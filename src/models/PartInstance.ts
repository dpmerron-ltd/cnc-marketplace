import type { Rotation } from './geometry'

export interface PartInstance {
  id: string
  partId: string
  x: number
  y: number
  rotation: Rotation
  locked: boolean
}
