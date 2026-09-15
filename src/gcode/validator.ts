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
  if (sheet.borderSpacing < 0) issues.push({ level: 'error', message: 'Border spacing cannot be negative.' })

  const placed = sheet.instances.map((instance) => {
    const part = parts.find((candidate) => candidate.id === instance.partId)
    return { instance, part, bounds: part ? instanceBounds(part, instance) : undefined }
  })

  let missingPartCount = 0
  for (const item of placed) {
    if (!item.part || !item.bounds) {
      missingPartCount += 1
      continue
    }

    const { bounds } = item
    if ([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].some((value) => !Number.isFinite(value))) issues.push({ level: 'error', message: `${item.part.name} has non-finite transformed bounds.` })
    if (bounds.minX < sheet.borderSpacing || bounds.minY < sheet.borderSpacing || bounds.maxX > sheet.width - sheet.borderSpacing || bounds.maxY > sheet.height - sheet.borderSpacing) {
      issues.push({ level: 'error', message: `${item.part.name} (${item.instance.id}) violates the ${sheet.borderSpacing} mm border spacing on sheet ${item.instance.sheetIndex + 1}.` })
    }

    const transformed = transformPartProgram(item.part, item.instance)
    transformed.errors.forEach((message) => issues.push({ level: 'error', message }))
    transformed.warnings.forEach((message) => issues.push({ level: 'warning', message }))
  }

  for (let a = 0; a < placed.length; a += 1) {
    for (let b = a + 1; b < placed.length; b += 1) {
      const first = placed[a]
      const second = placed[b]
      if (!first.bounds || !second.bounds || !first.part || !second.part) continue
      if (first.instance.sheetIndex !== second.instance.sheetIndex) continue
      if (rectsOverlap(first.bounds, second.bounds, sheet.spacing)) issues.push({ level: 'error', message: `${first.part.name} and ${second.part.name} overlap or violate spacing.` })
    }
  }

  if (missingPartCount > 0) {
    issues.unshift({
      level: 'error',
      message: `${missingPartCount} placed part${missingPartCount === 1 ? '' : 's'} reference component files that are no longer in the library.`,
    })
  }

  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.level}:${issue.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
