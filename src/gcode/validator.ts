import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import { rectsOverlap } from '../models/geometry'
import { instanceBounds, transformPartProgram } from './transform'

export interface ValidationIssue {
  level: 'error' | 'warning'
  message: string
}

export function validateSheet(parts: Part[], sheet: Sheet): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (sheet.width <= 0 || sheet.height <= 0) issues.push({ level: 'error', message: 'Sheet dimensions must be positive.' })

  const placed = sheet.instances.map((instance) => {
    const part = parts.find((candidate) => candidate.id === instance.partId)
    return { instance, part, bounds: part ? instanceBounds(part, instance) : undefined }
  })

  for (const item of placed) {
    if (!item.part || !item.bounds) {
      issues.push({ level: 'error', message: `Instance ${item.instance.id} references a missing part.` })
      continue
    }

    const { bounds } = item
    if ([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].some((value) => !Number.isFinite(value))) issues.push({ level: 'error', message: `${item.part.name} has non-finite transformed bounds.` })
    if (bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > sheet.width || bounds.maxY > sheet.height) issues.push({ level: 'error', message: `${item.part.name} (${item.instance.id}) extends beyond the sheet.` })

    const transformed = transformPartProgram(item.part, item.instance)
    transformed.errors.forEach((message) => issues.push({ level: 'error', message }))
    transformed.warnings.forEach((message) => issues.push({ level: 'warning', message }))
  }

  for (let a = 0; a < placed.length; a += 1) {
    for (let b = a + 1; b < placed.length; b += 1) {
      const first = placed[a]
      const second = placed[b]
      if (!first.bounds || !second.bounds || !first.part || !second.part) continue
      if (rectsOverlap(first.bounds, second.bounds, sheet.spacing)) issues.push({ level: 'error', message: `${first.part.name} and ${second.part.name} overlap or violate spacing.` })
    }
  }

  return issues
}
