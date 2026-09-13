import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'
import { rectsOverlap, rotatedSize } from '../models/geometry'
import type { Bounds } from '../models/geometry'
import { instanceBounds } from '../gcode/transform'

interface PlacedRect {
  sheetIndex: number
  bounds: Bounds
}

function fitsSheet(size: { width: number; height: number }, sheet: Sheet): boolean {
  return size.width <= sheet.width - sheet.borderSpacing * 2 && size.height <= sheet.height - sheet.borderSpacing * 2
}

function candidatePositions(sheet: Sheet, placed: PlacedRect[], sheetIndex: number, size: { width: number; height: number }): Array<{ x: number; y: number }> {
  const xs = new Set<number>([sheet.borderSpacing])
  const ys = new Set<number>([sheet.borderSpacing])

  for (const item of placed) {
    if (item.sheetIndex !== sheetIndex) continue
    xs.add(item.bounds.maxX + sheet.spacing)
    xs.add(item.bounds.minX - size.width - sheet.spacing)
    ys.add(item.bounds.maxY + sheet.spacing)
    ys.add(item.bounds.minY - size.height - sheet.spacing)
  }

  return [...xs]
    .flatMap((x) => [...ys].map((y) => ({ x: Math.max(sheet.borderSpacing, x), y: Math.max(sheet.borderSpacing, y) })))
    .filter((point) => point.x + size.width <= sheet.width - sheet.borderSpacing + 0.0001 && point.y + size.height <= sheet.height - sheet.borderSpacing + 0.0001)
    .sort((a, b) => a.y - b.y || a.x - b.x)
}

export function autoNest(parts: Part[], sheet: Sheet): PartInstance[] {
  const instances = sheet.instances.map((instance) => ({ ...instance }))
  const placed: PlacedRect[] = []

  for (const instance of instances) {
    if (!instance.locked) continue
    const part = parts.find((candidate) => candidate.id === instance.partId)
    if (part) placed.push({ sheetIndex: instance.sheetIndex, bounds: instanceBounds(part, instance) })
  }

  function canPlace(candidate: PartInstance, part: Part): boolean {
    const bounds = instanceBounds(part, candidate)
    if (bounds.minX < sheet.borderSpacing || bounds.minY < sheet.borderSpacing || bounds.maxX > sheet.width - sheet.borderSpacing || bounds.maxY > sheet.height - sheet.borderSpacing) return false
    return placed.every((item) => item.sheetIndex !== candidate.sheetIndex || !rectsOverlap(item.bounds, bounds, sheet.spacing))
  }

  for (const instance of instances) {
    if (instance.locked) continue
    const part = parts.find((candidate) => candidate.id === instance.partId)
    if (!part) continue

    const rotations = Array.from(new Set([instance.rotation, 0, 90, 180, 270] as const))
    if (!rotations.some((rotation) => fitsSheet(rotatedSize({ width: part.width, height: part.height }, rotation), sheet))) continue
    let placedInstance: PartInstance | undefined

    for (let sheetIndex = 0; !placedInstance; sheetIndex += 1) {
      for (const rotation of rotations) {
        const size = rotatedSize({ width: part.width, height: part.height }, rotation)
        if (!fitsSheet(size, sheet)) continue

        for (const point of candidatePositions(sheet, placed, sheetIndex, size)) {
          const candidate = { ...instance, sheetIndex, x: point.x, y: point.y, rotation }
          if (canPlace(candidate, part)) {
            placedInstance = candidate
            break
          }
          if (placedInstance) break
        }
        if (placedInstance) break
      }
    }

    Object.assign(instance, placedInstance)
    placed.push({ sheetIndex: instance.sheetIndex, bounds: instanceBounds(part, instance) })
  }

  return instances
}
