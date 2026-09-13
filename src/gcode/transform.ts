import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import { emptyBounds, includePoint, rotatePointInBounds, rotateVector } from '../models/geometry'
import type { Bounds, Point } from '../models/geometry'
import { formatWord, wordsToLine } from './format'
import { createInitialState, getWord, updatePositionFromLine } from './state'
import type { GCodeWord, ParsedLine, ToolpathSegment } from './types'

export interface TransformedProgram {
  lines: string[]
  transformedLines: ParsedLine[]
  segments: ToolpathSegment[]
  warnings: string[]
  errors: string[]
}

function replaceOrAppend(words: GCodeWord[], letter: string, value: number): GCodeWord[] {
  const index = words.findIndex((word) => word.letter === letter)
  const next = [...words]
  const word = { letter, value, raw: formatWord(letter, value) }
  if (index >= 0) next[index] = word
  else next.push(word)
  return next
}

export function transformLocalPoint(part: Part, instance: PartInstance, absolutePoint: Point): Point {
  const local = { x: absolutePoint.x - part.originalBounds.minX, y: absolutePoint.y - part.originalBounds.minY }
  const rotated = rotatePointInBounds(local, { width: part.width, height: part.height }, instance.rotation)
  return { x: instance.x + rotated.x, y: instance.y + rotated.y }
}

export function instanceBounds(part: Part, instance: PartInstance): Bounds {
  const corners = [
    { x: part.originalBounds.minX, y: part.originalBounds.minY },
    { x: part.originalBounds.maxX, y: part.originalBounds.minY },
    { x: part.originalBounds.maxX, y: part.originalBounds.maxY },
    { x: part.originalBounds.minX, y: part.originalBounds.maxY },
  ].map((point) => transformLocalPoint(part, instance, point))

  return corners.reduce((bounds, point) => includePoint(bounds, point), emptyBounds())
}

export function transformPartProgram(part: Part, instance: PartInstance): TransformedProgram {
  const errors: string[] = []
  const warnings = [...part.parsed.warnings]
  const lines: string[] = []
  const transformedLines: ParsedLine[] = []
  const segments: ToolpathSegment[] = []
  let state = createInitialState()

  for (const line of part.parsed.startLines) {
    state = updatePositionFromLine(state, line)
  }

  for (const line of part.parsed.bodyLines) {
    if (line.unsupportedForTransform) errors.push(`${part.name} line ${line.lineNumber + 1}: unsupported transform construct: ${line.unsupportedForTransform}.`)

    const before = state
    const nextState = updatePositionFromLine(state, line)
    const motion = line.effectiveMotion ?? nextState.motion
    const hasX = getWord(line, 'X') !== undefined
    const hasY = getWord(line, 'Y') !== undefined
    const zWord = getWord(line, 'Z')
    const hasSpatialXY = hasX || hasY
    let nextWords = line.words.map((word) => (word.letter === 'G' && Math.trunc(word.value) === 91 ? { letter: 'G', value: 90, raw: 'G90' } : word))
    let center: Point | undefined

    if (motion && hasSpatialXY) {
      const transformedStart = transformLocalPoint(part, instance, { x: before.position.x, y: before.position.y })
      const transformedEnd = transformLocalPoint(part, instance, { x: nextState.position.x, y: nextState.position.y })
      nextWords = replaceOrAppend(nextWords, 'X', transformedEnd.x)
      nextWords = replaceOrAppend(nextWords, 'Y', transformedEnd.y)

      if (motion === 'G02' || motion === 'G03') {
        const rotatedIJ = rotateVector({ x: getWord(line, 'I') ?? 0, y: getWord(line, 'J') ?? 0 }, instance.rotation)
        nextWords = replaceOrAppend(nextWords, 'I', rotatedIJ.x)
        nextWords = replaceOrAppend(nextWords, 'J', rotatedIJ.y)
        center = { x: transformedStart.x + rotatedIJ.x, y: transformedStart.y + rotatedIJ.y }
      }

      segments.push({
        type: motion === 'G00' ? 'rapid' : motion === 'G01' ? 'cut' : motion === 'G02' ? 'arc-cw' : 'arc-ccw',
        start: transformedStart,
        end: transformedEnd,
        center,
        bounds: includePoint(includePoint(emptyBounds(), transformedStart), transformedEnd),
        lineNumber: line.lineNumber,
        instanceId: instance.id,
        partId: part.id,
      })
    }

    if (zWord !== undefined && nextState.distanceMode === 'incremental') nextWords = replaceOrAppend(nextWords, 'Z', nextState.position.z)
    if (motion && hasX !== hasY && instance.rotation !== 0) warnings.push(`${part.name} line ${line.lineNumber + 1}: emitted both X and Y because rotation requires modal axis reconstruction.`)

    const transformedLine: ParsedLine = { ...line, words: nextWords, raw: wordsToLine(nextWords, line.comment) }
    transformedLines.push(transformedLine)
    lines.push(transformedLine.raw)
    state = nextState
  }

  for (const line of transformedLines) {
    if (!line.words.every((word) => Number.isFinite(word.value))) errors.push(`${part.name} line ${line.lineNumber + 1}: transformed line contains a non-finite coordinate.`)
  }

  return { lines, transformedLines, segments, warnings, errors }
}
