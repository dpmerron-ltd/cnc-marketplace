import type { Bounds } from './geometry'
import type { ParsedProgram, ToolpathSegment } from '../gcode/types'
import type { MaterialVariants } from '../cam/materialProfiles'
import type { CutSide } from './cutSide'

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
  // The face presented to the cutter. Missing values in older projects mean either side.
  cutSide?: CutSide
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

// Catalogue metadata only: never use this as a machinable Part.
export type ComponentSummary = Pick<Part, 'id' | 'ownerId' | 'itemId' | 'sku' | 'name' | 'cutSide' | 'originalFilename' | 'width' | 'height'> & { materialThicknessMm?: number }

export function summarizePart(part: Part): ComponentSummary {
  const hint = part.gcode.match(/\(Material\s+(\d+(?:\.\d+)?)\s*mm\s*\//i)?.[1]
    ?? part.metadata.materialVariants?.primaryProfile
  return { id: part.id, ownerId: part.ownerId, itemId: part.itemId, sku: part.sku, name: part.name,
    originalFilename: part.originalFilename, width: part.width, height: part.height, cutSide: part.cutSide ?? 'either',
    ...(hint ? { materialThicknessMm: Number.parseFloat(hint) } : {}),
  }
}
