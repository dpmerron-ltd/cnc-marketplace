import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import { wordsToLine } from './format'
import { createInitialState, updatePositionFromLine } from './state'
import type { ParsedLine } from './types'

const FULL_DEPTH_TOLERANCE_MM = 0.01

export function originalFinalDepth(part: Part): number | undefined {
  let state = createInitialState()
  let deepestZ = 0

  for (const line of part.parsed.bodyLines) {
    const next = updatePositionFromLine(state, line)
    const motion = line.effectiveMotion ?? next.motion
    if ((motion === 'G01' || motion === 'G02' || motion === 'G03') && next.position.z < deepestZ) {
      deepestZ = next.position.z
    }
    state = next
  }

  return deepestZ < 0 ? Math.abs(deepestZ) : undefined
}

function isCutMotion(line: ParsedLine): boolean {
  return line.effectiveMotion === 'G01' || line.effectiveMotion === 'G02' || line.effectiveMotion === 'G03'
}

function isOperationComment(line: ParsedLine): boolean {
  return /^\(No\.\s*\d+\s+.+\)$/i.test(line.raw.trim())
}

function operationDepths(part: Part): Map<number, number> {
  const depths = new Map<number, number>()
  let state = createInitialState()
  let operationIndex = 0

  for (const line of part.parsed.bodyLines) {
    if (isOperationComment(line)) operationIndex += 1
    const next = updatePositionFromLine(state, line)
    if (isCutMotion(line) && next.position.z < 0) {
      depths.set(operationIndex, Math.max(depths.get(operationIndex) ?? 0, Math.abs(next.position.z)))
    }
    state = next
  }

  return depths
}

export function depthScaleForPart(part: Part, sheet: Sheet): number | undefined {
  const targetDepth = sheet.gcodeSettings.finalCutDepth
  if (targetDepth === undefined || targetDepth <= 0) return undefined
  const sourceDepth = originalFinalDepth(part)
  if (!sourceDepth || sourceDepth <= 0) return undefined
  return targetDepth / sourceDepth
}

export function scaleZDepth(z: number, scale?: number): number {
  if (scale === undefined || scale <= 0 || z >= 0) return z
  return z * scale
}

export function fullDepthOperationIndexes(part: Part): Set<number> {
  const sourceDepth = originalFinalDepth(part)
  if (!sourceDepth) return new Set()

  const fullDepthOperations = new Set<number>()
  for (const [operationIndex, depth] of operationDepths(part)) {
    if (Math.abs(depth - sourceDepth) <= FULL_DEPTH_TOLERANCE_MM) fullDepthOperations.add(operationIndex)
  }
  return fullDepthOperations
}

export function linesWithDepthOverride(part: Part, lines: ParsedLine[], scale?: number): ParsedLine[] {
  if (scale === undefined || scale <= 0) return lines

  const fullDepthOperations = fullDepthOperationIndexes(part)
  let operationIndex = 0

  return lines.map((line) => {
    if (isOperationComment(line)) operationIndex += 1
    if (!fullDepthOperations.has(operationIndex)) return line
    return lineWithDepthOverride(line, scale)
  })
}

export function lineWithDepthOverride(line: ParsedLine, scale?: number): ParsedLine {
  if (scale === undefined || scale <= 0) return line
  if (!isCutMotion(line)) return line
  const zIndex = line.words.findIndex((word) => word.letter === 'Z')
  if (zIndex < 0) return line

  const z = line.words[zIndex].value
  const nextZ = scaleZDepth(z, scale)
  if (nextZ === z) return line

  const words = [...line.words]
  words[zIndex] = { letter: 'Z', value: nextZ, raw: `Z${nextZ}` }
  return { ...line, words, raw: wordsToLine(words, line.comment) }
}
