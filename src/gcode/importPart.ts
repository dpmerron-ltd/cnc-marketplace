import type { Part } from '../models/Part'
import { boundsSize } from '../models/geometry'
import { calculateMachiningBounds, getProgramSegments } from './bounds'
import { parseGCode } from './parser'

function idFromName(name: string): string {
  return `${name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`
}

export function createPartFromGCode(filename: string, gcode: string, dxf?: string, itemId?: string): Part {
  const parsed = parseGCode(gcode)
  const originalBounds = calculateMachiningBounds(parsed)
  const size = boundsSize(originalBounds)

  return {
    id: idFromName(filename),
    itemId,
    sku: '',
    name: filename.replace(/\.[^.]+$/, ''),
    originalFilename: filename,
    gcode,
    parsed,
    width: size.width,
    height: size.height,
    boundingBox: { minX: 0, minY: 0, maxX: size.width, maxY: size.height },
    originalBounds,
    originalOffset: { x: originalBounds.minX, y: originalBounds.minY },
    dxf,
    toolpathPreview: getProgramSegments(parsed),
    dateImported: new Date().toISOString(),
    metadata: { units: parsed.units, positioning: parsed.distanceMode, warnings: parsed.warnings },
  }
}
