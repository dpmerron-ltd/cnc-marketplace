import type { Bounds } from './geometry'
import type { ParsedProgram, ToolpathSegment } from '../gcode/types'
import type { MaterialVariants } from '../cam/materialProfiles'

export interface PartMetadata {
  units: 'mm' | 'inch' | 'unknown'
  positioning: 'absolute' | 'incremental' | 'unknown'
  warnings: string[]
  materialVariants?: MaterialVariants
}

export interface Part {
  id: string
  ownerId?: string
  itemId?: string
  sku: string
  name: string
  originalFilename: string
  gcode: string
  parsed: ParsedProgram
  width: number
  height: number
  boundingBox: Bounds
  originalBounds: Bounds
  originalOffset: { x: number; y: number }
  dxf?: string
  toolpathPreview: ToolpathSegment[]
  dateImported: string
  metadata: PartMetadata
}
