import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import { depthScaleForPart, lineWithDepthOverride } from './depthOverride'
import { formatNumber } from './format'
import { wordsToLine } from './format'
import { instanceBounds, transformLocalPoint, transformPartProgram } from './transform'
import type { ParsedLine } from './types'
import type { Point } from '../models/geometry'

export interface ExportResult {
  gcode: string
  errors: string[]
  warnings: string[]
}

export interface SheetExportResult extends ExportResult {
  sheetIndex: number
}

function lineWithFeedOverride(line: ParsedLine, feedRate?: number): string {
  if (!feedRate || feedRate <= 0) return line.raw
  const feedIndex = line.words.findIndex((word) => word.letter === 'F')
  const words = [...line.words]
  const feedWord = { letter: 'F', value: feedRate, raw: `F${formatNumber(feedRate)}` }
  if (feedIndex >= 0) words[feedIndex] = feedWord
  else words.push(feedWord)

  return wordsToLine(words, line.comment)
}

function feedRateMmPerMinute(sheet: Sheet, mode: 'cut' | 'plunge' | 'ramp'): number | undefined {
  const settings = sheet.gcodeSettings
  const feedMmPerSecond =
    mode === 'cut'
      ? settings.cuttingFeedRateMmPerSecond
      : mode === 'plunge'
        ? settings.plungeFeedRateMmPerSecond
        : settings.rampFeedRateMmPerSecond
  const legacyFeedMmPerMinute =
    mode === 'cut'
      ? settings.cuttingFeedRateMmPerMinute
      : mode === 'plunge'
        ? settings.plungeFeedRateMmPerMinute
        : settings.rampFeedRateMmPerMinute

  return feedMmPerSecond !== undefined ? feedMmPerSecond * 60 : legacyFeedMmPerMinute
}

function instanceStartPoint(part: Part, instance: Sheet['instances'][number], transformed: ReturnType<typeof transformPartProgram>): Point {
  return transformed.segments[0]?.start ?? transformLocalPoint(part, instance, { x: part.originalBounds.minX, y: part.originalBounds.minY })
}

function wordValue(line: ParsedLine, letter: string): number | undefined {
  return line.words.find((word) => word.letter === letter)?.value
}

function lineWithToolFeed(line: ParsedLine, previousZ: number | undefined, sheet: Sheet): { raw: string; nextZ: number | undefined; mode?: 'cut' | 'plunge' | 'ramp' } {
  const z = wordValue(line, 'Z')
  const nextZ = z ?? previousZ
  const motion = line.effectiveMotion
  if (!sheet.gcodeSettings.applyXyFeedRate || (motion !== 'G01' && motion !== 'G02' && motion !== 'G03')) {
    return { raw: line.raw, nextZ }
  }

  const hasXy = line.words.some((word) => word.letter === 'X' || word.letter === 'Y')
  const hasZ = z !== undefined
  const movesDown = hasZ && previousZ !== undefined && z < previousZ - 0.0001
  if (movesDown && hasXy) {
    return { raw: lineWithFeedOverride(line, feedRateMmPerMinute(sheet, 'ramp')), nextZ, mode: 'ramp' }
  }
  if (movesDown) {
    return { raw: lineWithFeedOverride(line, feedRateMmPerMinute(sheet, 'plunge')), nextZ, mode: 'plunge' }
  }
  if (hasXy) {
    return { raw: lineWithFeedOverride(line, feedRateMmPerMinute(sheet, 'cut')), nextZ, mode: 'cut' }
  }

  return { raw: line.raw, nextZ }
}

function reachCheckLines(parts: Part[], sheet: Sheet, sheetIndex: number): { lines: string[]; errors: string[] } {
  if (!sheet.gcodeSettings.reachCheckEnabled) return { lines: [], errors: [] }

  const errors: string[] = []
  let maxX: number | undefined
  let maxY: number | undefined

  for (const instance of sheet.instances.filter((candidate) => candidate.sheetIndex === sheetIndex)) {
    const part = parts.find((candidate) => candidate.id === instance.partId)
    if (!part) {
      errors.push(`Instance ${instance.id} references a missing library part.`)
      continue
    }
    const bounds = instanceBounds(part, instance)
    maxX = maxX === undefined ? bounds.maxX : Math.max(maxX, bounds.maxX)
    maxY = maxY === undefined ? bounds.maxY : Math.max(maxY, bounds.maxY)
  }

  if (maxX === undefined || maxY === undefined) return { lines: [], errors }

  return {
    lines: [
      `(Reach check: furthest transformed X/Y extent on physical sheet ${sheetIndex + 1})`,
      `G00 Z${formatNumber(sheet.gcodeSettings.safeZ)}`,
      `G00 X${formatNumber(maxX)} Y${formatNumber(maxY)}`,
    ],
    errors,
  }
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
  const feedModes = new Set<'cut' | 'plunge' | 'ramp'>()
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
    output.push(`(Part: ${part.name})`)
    output.push(`(SKU: ${part.sku})`)
    output.push(`(Instance: ${instanceNumber} / ${instance.id})`)
    output.push(`(Physical sheet: ${instance.sheetIndex + 1})`)
    output.push(`(Position: X${formatNumber(instance.x)} Y${formatNumber(instance.y)})`)
    output.push(`(Rotation: ${instance.rotation})`)
    output.push(`G00 Z${formatNumber(sheet.gcodeSettings.safeZ)}`)
    output.push(`G00 X${formatNumber(firstPoint.x)} Y${formatNumber(firstPoint.y)}`)

    errors.push(...transformed.errors)
    warnings.push(...transformed.warnings)
    const depthScale = depthScaleForPart(part, sheet)
    const transformedLines = transformed.transformedLines.map((line) => lineWithDepthOverride(line, depthScale))
    const rapidBelowSurfaceCount = transformedLines.filter((line) => line.effectiveMotion === 'G00' && (wordValue(line, 'Z') ?? 0) < 0).length
    if (depthScale !== undefined) {
      warnings.push(`Applied final depth override to ${part.name}: exported deepest Z is -${formatNumber(sheet.gcodeSettings.finalCutDepth ?? 0)} mm.`)
    }
    if (rapidBelowSurfaceCount > 0) {
      warnings.push(`${part.name} contains ${rapidBelowSurfaceCount} rapid Z move${rapidBelowSurfaceCount === 1 ? '' : 's'} below Z0; verify the source CAM clearance path before cutting.`)
    }
    if (sheet.gcodeSettings.applyXyFeedRate) {
      let previousZ: number | undefined = 0
      const feedLines = transformedLines.map((line) => {
        const result = lineWithToolFeed(line, previousZ, sheet)
        previousZ = result.nextZ
        if (result.mode) feedModes.add(result.mode)
        return result.raw
      })
      output.push(...feedLines)
    } else {
      output.push(...transformedLines.map((line) => line.raw))
    }
  }

  if (feedModes.size > 0) {
    const cut = feedRateMmPerMinute(sheet, 'cut') ?? 0
    const plunge = feedRateMmPerMinute(sheet, 'plunge') ?? 0
    const ramp = feedRateMmPerMinute(sheet, 'ramp') ?? 0
    warnings.push(
      `Applied feed overrides: cut ${formatNumber(cut / 60)} mm/s (F${formatNumber(cut)}), plunge ${formatNumber(plunge / 60)} mm/s (F${formatNumber(plunge)}), ramp ${formatNumber(ramp / 60)} mm/s (F${formatNumber(ramp)}).`,
    )
  }

  return { lines: output, errors, warnings, nextInstanceNumber: instanceNumber }
}

export function exportCombinedGCode(parts: Part[], sheet: Sheet): ExportResult {
  const errors: string[] = []
  const warnings: string[] = []
  const output: string[] = []
  const sheetCount = Math.max(1, ...sheet.instances.map((instance) => instance.sheetIndex + 1))

  output.push('(Combined CNC job generated by Sheet Builder)')
  output.push(`(Sheet name: ${sheet.name})`)
  output.push(`(Sheet: ${formatNumber(sheet.width)} x ${formatNumber(sheet.height)} mm)`)
  output.push(`(Physical sheets: ${sheetCount})`)
  output.push(...sheet.gcodeSettings.startGcode.split('\n').filter(Boolean))

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
  output.push(...sheet.gcodeSettings.endGcode.split('\n').filter(Boolean))

  return { gcode: `${output.join('\n')}\n`, errors, warnings: Array.from(new Set(warnings)) }
}

export function exportPhysicalSheetGCodes(parts: Part[], sheet: Sheet): SheetExportResult[] {
  const sheetCount = Math.max(1, ...sheet.instances.map((instance) => instance.sheetIndex + 1))

  return Array.from({ length: sheetCount }, (_, sheetIndex) => {
    const output: string[] = []
    const sheetInstanceIds = sheet.instances.filter((candidate) => candidate.sheetIndex === sheetIndex).map((instance) => instance.id)
    const transformed = transformedInstanceLines(parts, sheet, sheetInstanceIds)

    output.push('(CNC sheet program generated by Sheet Builder)')
    output.push(`(Sheet name: ${sheet.name})`)
    output.push(`(Physical sheet: ${sheetIndex + 1} of ${sheetCount})`)
    output.push(`(Sheet size: ${formatNumber(sheet.width)} x ${formatNumber(sheet.height)} mm)`)
    output.push(...sheet.gcodeSettings.startGcode.split('\n').filter(Boolean))
    const reachCheck = reachCheckLines(parts, sheet, sheetIndex)
    output.push(...reachCheck.lines)
    output.push(...sheet.gcodeSettings.spindleStartGcode.split('\n').filter(Boolean))
    output.push(...transformed.lines)
    output.push('')
    output.push(`G00 Z${formatNumber(sheet.gcodeSettings.safeZ)}`)
    output.push(...sheet.gcodeSettings.endGcode.split('\n').filter(Boolean))

    return {
      sheetIndex,
      gcode: `${output.join('\n')}\n`,
      errors: [...reachCheck.errors, ...transformed.errors],
      warnings: Array.from(new Set(transformed.warnings)),
    }
  })
}
