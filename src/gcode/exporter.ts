import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import { isFiniteBounds } from '../models/geometry'
import { formatNumber } from './format'
import { planScrewPositions, screwMarkDepthMm, screwMarkFeedMmPerMinute } from './screwPositions'
import { parseGCode } from './parser'
import { preparationBounds } from './preparationBounds'
import { effectiveSafeZ, overrideClearance } from './safeZ'
import { startProgramLines, validatePrograms, type ProgramSettings } from './programSettings'
import { transformLocalPoint, transformPartProgram } from './transform'
import type { ParsedLine } from './types'
import type { Point } from '../models/geometry'
import { numberSheetParts, partNumberText } from '../labels/partLabels'

function commentText(value: string): string {
  return value.replace(/[\r\n()]/g, ' ')
}

export interface ExportResult {
  gcode: string
  errors: string[]
  warnings: string[]
}

export interface SheetExportResult extends ExportResult {
  sheetIndex: number
}

function instanceStartPoint(part: Part, instance: Sheet['instances'][number], transformed: ReturnType<typeof transformPartProgram>): Point {
  const first = transformed.segments[0]
  const cutsBeforeFirstXY = first && part.parsed.bodyLines.some(line => line.lineNumber < first.lineNumber! && ['G01', 'G02', 'G03'].includes(line.effectiveMotion ?? ''))
  // An entry rapid has no meaningful source start: arrive at its destination at safe Z.
  // Cutting/arc entries still require their actual start to preserve the first cut.
  return first ? first.type === 'rapid' && !cutsBeforeFirstXY ? first.end : first.start : transformLocalPoint(part, instance, { x: part.originalBounds.minX, y: part.originalBounds.minY })
}

function wordValue(line: ParsedLine, letter: string): number | undefined {
  return line.words.find((word) => word.letter === letter)?.value
}

function isBlankOrCommentOnly(line: ParsedLine): boolean {
  return line.words.length === 0
}

function isRapidLine(line: ParsedLine): boolean {
  return line.effectiveMotion === 'G00'
}

function withoutSourceFooterRapids(lines: ParsedLine[]): ParsedLine[] {
  let end = lines.length

  while (end > 0 && isBlankOrCommentOnly(lines[end - 1])) end -= 1
  while (end > 0 && isRapidLine(lines[end - 1])) end -= 1
  while (end > 0 && isBlankOrCommentOnly(lines[end - 1])) end -= 1

  return lines.slice(0, end)
}

function reachCheckLines(parts: Part[], sheet: Sheet, sheetIndex: number): { lines: string[]; errors: string[] } {
  if (![sheet.width, sheet.height].every(value => Number.isFinite(value) && value > 0)) {
    return { lines: [], errors: ['Reach check requires finite positive sheet dimensions.'] }
  }
  const errors: string[] = []
  let maxX: number | undefined
  let maxY: number | undefined

  for (const instance of sheet.instances.filter((candidate) => candidate.sheetIndex === sheetIndex)) {
    const part = parts.find((candidate) => candidate.id === instance.partId)
    if (!part) {
      errors.push(`Instance ${instance.id} references a missing library part.`)
      continue
    }
    const prepared = preparationBounds(part, instance, sheet.gcodeSettings.safeZ)
    errors.push(...prepared.errors)
    const bounds = prepared.bounds
    if (!isFiniteBounds(bounds) || bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > sheet.width || bounds.maxY > sheet.height) {
      errors.push(`${part.name} has invalid or out-of-sheet machining bounds for the reach check.`)
      continue
    }
    maxX = maxX === undefined ? bounds.maxX : Math.max(maxX, bounds.maxX)
    maxY = maxY === undefined ? bounds.maxY : Math.max(maxY, bounds.maxY)
  }

  if (maxX === undefined || maxY === undefined) return { lines: [], errors }
  if (!Number.isFinite(sheet.gcodeSettings.safeZ) || sheet.gcodeSettings.safeZ <= 0) {
    return { lines: [], errors: [...errors, 'Reach check requires a positive safe Z above the material.'] }
  }
  if (errors.length > 0) return { lines: [], errors }

  return {
    lines: [
      `(Reach check: furthest transformed X/Y extent on physical sheet ${sheetIndex + 1})`,
      'M05',
      'G21',
      'G17',
      'G90',
      'G94',
      `G00 Z${formatNumber(sheet.gcodeSettings.safeZ)}`,
      `G00 X${formatNumber(maxX)} Y${formatNumber(maxY)}`,
    ],
    errors,
  }
}

function screwMarkingLines(parts: Part[], sheet: Sheet, sheetIndex: number): { lines: string[]; errors: string[]; warnings: string[] } {
  const plan = planScrewPositions(parts, sheet, sheetIndex)
  const lines: string[] = []
  const result = { errors: plan.errors, warnings: plan.warnings, lines }
  if (!plan.points.length || plan.errors.length) return result
  for (const instance of sheet.instances.filter(instance => instance.sheetIndex === sheetIndex)) {
    const part = parts.find(part => part.id === instance.partId)
    if (!part) continue
    let feed: number | undefined
    for (const line of [...part.parsed.startLines, ...part.parsed.bodyLines]) {
      feed = wordValue(line, 'F') ?? feed
      if (line.effectiveMotion && line.effectiveMotion !== 'G00') {
        if (!feed || !Number.isFinite(feed) || feed <= 0) result.errors.push(`${part.name} must specify a source feed before its first cutting move so screw-marking feed cannot carry into machining.`)
        break
      }
    }
  }
  if (result.errors.length) return result
  const spindleWords = parseGCode(sheet.gcodeSettings.spindleStartGcode).lines.flatMap(line => line.words)
  const spindleCommand = spindleWords.filter(word => word.letter === 'M' && [3, 4, 5].includes(word.value)).at(-1)?.value
  const spindleSpeed = spindleWords.filter(word => word.letter === 'S').at(-1)?.value
  if (spindleCommand !== 3 || !spindleSpeed || spindleSpeed <= 0 || !Number.isFinite(spindleSpeed)) {
    result.errors.push('Screw marking requires a spindle start block with a positive S speed and M03. Disable screw marking for a manually switched router; M05 cannot stop it for fitting screws.')
    return result
  }
  if (!Number.isFinite(sheet.gcodeSettings.safeZ) || sheet.gcodeSettings.safeZ < 0.5) {
    result.errors.push('Screw marking requires safe Z of at least 0.5 mm above the material.')
    return result
  }

  lines.push(`(Screw marks: ${plan.points.length}; 6 mm cutter; recessed screws; Z0 at material surface)`)
  lines.push(...sheet.gcodeSettings.spindleStartGcode.split('\n').filter(Boolean))
  lines.push(`G00 Z${formatNumber(sheet.gcodeSettings.safeZ)}`)
  for (const [index, point] of plan.points.entries()) {
    lines.push(`(Screw mark ${index + 1})`)
    lines.push(`G00 X${formatNumber(point.x)} Y${formatNumber(point.y)}`)
    lines.push('G00 Z0.5')
    lines.push(`G01 Z-${screwMarkDepthMm} F${screwMarkFeedMmPerMinute}`)
    lines.push(`G00 Z${formatNumber(sheet.gcodeSettings.safeZ)}`)
  }
  lines.push('M05', 'G00 X0 Y0', '(Fit recessed screws in the marked positions, then press START)', 'M00')
  lines.push('(Resume part machining)', 'G21', 'G17', 'G90', 'G94')
  return result
}

function transformedInstanceLines(
  parts: Part[],
  sheet: Sheet,
  instanceIds: string[],
  startingInstanceNumber = 0,
): { lines: string[]; errors: string[]; warnings: string[]; nextInstanceNumber: number } {
  const output: string[] = []
  const errors: string[] = []
  const warnings: string[] = []
  let instanceNumber = startingInstanceNumber

  for (const instance of sheet.instances.filter((candidate) => instanceIds.includes(candidate.id))) {
    instanceNumber += 1
    const part = parts.find((candidate) => candidate.id === instance.partId)
    if (!part) {
      errors.push(`Instance ${instance.id} references a missing library part.`)
      continue
    }

    const transformed = transformPartProgram(part, instance)
    const firstPoint = instanceStartPoint(part, instance, transformed)
    output.push('')
    output.push(`(Part number: ${partNumberText(instance.partNumber!)})`)
    output.push(`(Part: ${commentText(part.name)})`)
    output.push(`(SKU: ${commentText(part.sku)})`)
    output.push(`(Instance: ${instanceNumber} / ${instance.id})`)
    output.push(`(Physical sheet: ${instance.sheetIndex + 1})`)
    output.push(`(Position: X${formatNumber(instance.x)} Y${formatNumber(instance.y)})`)
    output.push(`(Rotation: ${instance.rotation})`)
    output.push(`G00 Z${formatNumber(sheet.gcodeSettings.safeZ)}`)
    output.push(`G00 X${formatNumber(firstPoint.x)} Y${formatNumber(firstPoint.y)}`)
    const sourceInitialFeed = part.parsed.startLines.flatMap(line => line.words).filter(word => word.letter === 'F').at(-1)?.value
    if (sourceInitialFeed !== undefined) output.push(`F${formatNumber(sourceInitialFeed)}`)

    errors.push(...transformed.errors)
    warnings.push(...transformed.warnings)
    const transformedLines = withoutSourceFooterRapids(transformed.transformedLines)
    const rapidBelowSurfaceCount = transformedLines.filter((line) => line.effectiveMotion === 'G00' && (wordValue(line, 'Z') ?? 0) < 0).length
    if (rapidBelowSurfaceCount > 0) {
      warnings.push(`${part.name} contains ${rapidBelowSurfaceCount} rapid Z move${rapidBelowSurfaceCount === 1 ? '' : 's'} below Z0; verify the source CAM clearance path before cutting.`)
    }
    if (sheet.safeZOverrideMm != null) {
      const overridden = overrideClearance(part, transformedLines, sheet.safeZOverrideMm)
      errors.push(...overridden.errors)
      output.push(...overridden.lines)
    } else {
      output.push(...transformedLines.map((line) => line.raw))
    }
  }

  return { lines: output, errors, warnings, nextInstanceNumber: instanceNumber }
}

export function exportCombinedGCode(parts: Part[], sheet: Sheet, programs?: ProgramSettings): ExportResult {
  const safeZ = effectiveSafeZ(sheet)
  if (programs) {
    const errors = validatePrograms(programs, safeZ)
    if (errors.length) return { gcode: '', errors, warnings: [] }
    sheet = { ...sheet, gcodeSettings: { ...sheet.gcodeSettings, ...programs } }
  }
  if (!Number.isFinite(safeZ) || safeZ <= 0) return { gcode: '', errors: ['Safe Z must be a finite positive height above the material.'], warnings: [] }
  sheet = numberSheetParts({ ...sheet, gcodeSettings: { ...sheet.gcodeSettings, safeZ } })
  const errors: string[] = []
  const warnings: string[] = []
  const output: string[] = []
  const sheetCount = Math.max(1, ...sheet.instances.map((instance) => instance.sheetIndex + 1))

  output.push('(Combined CNC job generated by Sheet Builder)')
  output.push(`(Sheet name: ${commentText(sheet.name)})`)
  if (sheet.orderNumber) output.push(`(Order number: ${commentText(sheet.orderNumber)})`)
  output.push(`(Sheet: ${formatNumber(sheet.width)} x ${formatNumber(sheet.height)} mm)`)
  output.push(`(Physical sheets: ${sheetCount})`)
  output.push(...(programs ? startProgramLines(programs, safeZ) : sheet.gcodeSettings.startGcode.split('\n').filter(Boolean)))

  let instanceNumber = 0
  for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex += 1) {
    if (sheetIndex > 0) {
      output.push('')
      output.push(`(Load physical sheet ${sheetIndex + 1}, align material to X0 Y0, then resume)`)
      output.push(`G00 Z${formatNumber(sheet.gcodeSettings.safeZ)}`)
      output.push('M05')
      output.push('M00')
    }

    output.push('')
    output.push(`(Physical sheet ${sheetIndex + 1} of ${sheetCount})`)
    const reachCheck = reachCheckLines(parts, sheet, sheetIndex)
    errors.push(...reachCheck.errors)
    output.push(...reachCheck.lines)
    const screwMarking = screwMarkingLines(parts, sheet, sheetIndex)
    errors.push(...screwMarking.errors)
    warnings.push(...screwMarking.warnings)
    output.push(...screwMarking.lines)
    output.push(...sheet.gcodeSettings.spindleStartGcode.split('\n').filter(Boolean))

    const sheetInstanceIds = sheet.instances.filter((candidate) => candidate.sheetIndex === sheetIndex).map((instance) => instance.id)
    const transformed = transformedInstanceLines(parts, sheet, sheetInstanceIds, instanceNumber)
    instanceNumber = transformed.nextInstanceNumber
    errors.push(...transformed.errors)
    warnings.push(...transformed.warnings)
    output.push(...transformed.lines)
  }

  output.push('')
  output.push(`G00 Z${formatNumber(sheet.gcodeSettings.safeZ)}`)
  if (programs) output.push('M05')
  output.push(...sheet.gcodeSettings.endGcode.split('\n').filter(Boolean))

  return { gcode: `${output.join('\n')}\n`, errors, warnings: Array.from(new Set(warnings)) }
}

export function exportPhysicalSheetGCodes(parts: Part[], sheet: Sheet, programs?: ProgramSettings): SheetExportResult[] {
  const sheetCount = Math.max(1, ...sheet.instances.map((instance) => instance.sheetIndex + 1))
  const safeZ = effectiveSafeZ(sheet)
  if (programs) {
    const errors = validatePrograms(programs, safeZ)
    if (errors.length) return Array.from({ length: sheetCount }, (_, sheetIndex) => ({ sheetIndex, gcode: '', errors, warnings: [] }))
    sheet = { ...sheet, gcodeSettings: { ...sheet.gcodeSettings, ...programs } }
  }
  if (!Number.isFinite(safeZ) || safeZ <= 0) return Array.from({ length: sheetCount }, (_, sheetIndex) => ({ sheetIndex, gcode: '', errors: ['Safe Z must be a finite positive height above the material.'], warnings: [] }))
  sheet = numberSheetParts({ ...sheet, gcodeSettings: { ...sheet.gcodeSettings, safeZ } })

  return Array.from({ length: sheetCount }, (_, sheetIndex) => {
    const output: string[] = []
    const sheetInstanceIds = sheet.instances.filter((candidate) => candidate.sheetIndex === sheetIndex).map((instance) => instance.id)
    const transformed = transformedInstanceLines(parts, sheet, sheetInstanceIds)

    output.push('(CNC sheet program generated by Sheet Builder)')
    output.push(`(Sheet name: ${commentText(sheet.name)})`)
    if (sheet.orderNumber) output.push(`(Order number: ${commentText(sheet.orderNumber)})`)
    output.push(`(Physical sheet: ${sheetIndex + 1} of ${sheetCount})`)
    output.push(`(Sheet size: ${formatNumber(sheet.width)} x ${formatNumber(sheet.height)} mm)`)
    output.push(...(programs ? startProgramLines(programs, safeZ) : sheet.gcodeSettings.startGcode.split('\n').filter(Boolean)))
    const reachCheck = reachCheckLines(parts, sheet, sheetIndex)
    output.push(...reachCheck.lines)
    const screwMarking = screwMarkingLines(parts, sheet, sheetIndex)
    output.push(...screwMarking.lines)
    output.push(...sheet.gcodeSettings.spindleStartGcode.split('\n').filter(Boolean))
    output.push(...transformed.lines)
    output.push('')
    output.push(`G00 Z${formatNumber(sheet.gcodeSettings.safeZ)}`)
    if (programs) output.push('M05')
    output.push(...sheet.gcodeSettings.endGcode.split('\n').filter(Boolean))

    return {
      sheetIndex,
      gcode: `${output.join('\n')}\n`,
      errors: [...reachCheck.errors, ...screwMarking.errors, ...transformed.errors],
      warnings: Array.from(new Set([...screwMarking.warnings, ...transformed.warnings])),
    }
  })
}
