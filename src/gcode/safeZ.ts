import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import { formatNumber, wordsToLine } from './format'
import { createInitialState, getWord, updatePositionFromLine } from './state'
import type { ParsedLine } from './types'

export const defaultSafeZOverrideMm = 20

export function effectiveSafeZ(sheet: Sheet): number {
  return sheet.safeZOverrideMm ?? sheet.gcodeSettings.safeZ
}

export function overrideClearance(part: Part, lines: ParsedLine[], safeZ: number): { lines: string[]; errors: string[] } {
  const output: string[] = []
  const errors: string[] = []
  let source = part.parsed.startLines.reduce(updatePositionFromLine, createInitialState())
  let outputZ = safeZ

  for (const [index, line] of lines.entries()) {
    const next = updatePositionFromLine(source, line)
    const z = getWord(line, 'Z')
    const hasXY = getWord(line, 'X') !== undefined || getWord(line, 'Y') !== undefined
    let replacementZ: number | undefined
    let peckRetract = false
    if (z === 0.5 && source.position.z < 0 && source.motion === 'G01' && line.words.every(word => ['Z', 'N'].includes(word.letter) || word.letter === 'G' && word.value === 0)) {
      // Preserve only a same-hole retract immediately followed by a deeper vertical feed.
      let following = index + 1
      while (following < lines.length && !lines[following].words.length) following++
      const feed = lines[following]
      peckRetract = Boolean(feed && feed.effectiveMotion === 'G01' && (getWord(feed, 'Z') ?? Infinity) < source.position.z && feed.words.every(word => ['Z', 'F', 'N'].includes(word.letter) || word.letter === 'G' && word.value === 1))
    }
    if (line.effectiveMotion === 'G00') {
      if (hasXY && next.position.z > 0) {
        // Raise vertically before lateral travel, never diagonally through an obstruction.
        if (outputZ !== safeZ) output.push(`G00 Z${formatNumber(safeZ)}`)
        outputZ = safeZ
        if (z !== undefined) replacementZ = safeZ
      } else if (hasXY && source.position.z > 0 && z !== undefined && z <= 0) {
        errors.push(`${part.name} line ${line.lineNumber + 1}: safe Z override cannot adjust a combined rapid XY move into the material.`)
      } else if (!peckRetract && !hasXY && z !== undefined && z > 0 && z > source.position.z && (source.position.z < 0 || z >= outputZ)) {
        replacementZ = safeZ
      }
    }

    if (replacementZ !== undefined) {
      output.push(wordsToLine(line.words.map(word => word.letter === 'Z' ? { ...word, value: replacementZ! } : word), line.comment))
      outputZ = replacementZ
    } else {
      output.push(line.raw)
      if (z !== undefined) outputZ = z
    }
    source = next
  }
  return { lines: output, errors }
}
