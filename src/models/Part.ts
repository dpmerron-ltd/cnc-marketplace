import type { Bounds } from './geometry'
import type { ParsedProgram, ToolpathSegment } from '../gcode/types'

export interface PartMetadata {
  units: 'mm' | 'inch' | 'unknown'
  positioning: 'absolute' | 'incremental' | 'unknown'
  warnings: string[]
}

export interface Part {
  id: string
  itemId?: string
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
