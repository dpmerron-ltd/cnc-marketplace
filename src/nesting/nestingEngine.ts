import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'
import { rotatedSize } from '../models/geometry'

export function autoNest(parts: Part[], sheet: Sheet): PartInstance[] {
  const instances = sheet.instances.map((instance) => ({ ...instance }))
  let cursorX = sheet.spacing
  let cursorY = sheet.spacing
  let rowHeight = 0

  for (const instance of instances) {
    if (instance.locked) continue
    const part = parts.find((candidate) => candidate.id === instance.partId)
    if (!part) continue

    const rotations = [instance.rotation, 90, 0, 270, 180] as const
    const chosenRotation = rotations.find((rotation) => {
      const size = rotatedSize({ width: part.width, height: part.height }, rotation)
      return cursorX + size.width <= sheet.width - sheet.spacing
    }) ?? instance.rotation
    const size = rotatedSize({ width: part.width, height: part.height }, chosenRotation)

    if (cursorX + size.width > sheet.width - sheet.spacing) {
      cursorX = sheet.spacing
      cursorY += rowHeight + sheet.spacing
      rowHeight = 0
    }

    instance.x = cursorX
    instance.y = cursorY
    instance.rotation = chosenRotation
    cursorX += size.width + sheet.spacing
    rowHeight = Math.max(rowHeight, size.height)
  }

  return instances
}
