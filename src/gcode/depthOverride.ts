import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import { wordsToLine } from './format'
import { createInitialState, updatePositionFromLine } from './state'
import type { ParsedLine } from './types'

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

export function lineWithDepthOverride(line: ParsedLine, scale?: number): ParsedLine {
  if (scale === undefined || scale <= 0) return line
  const zIndex = line.words.findIndex((word) => word.letter === 'Z')
  if (zIndex < 0) return line

  const z = line.words[zIndex].value
  const nextZ = scaleZDepth(z, scale)
  if (nextZ === z) return line

  const words = [...line.words]
  words[zIndex] = { letter: 'Z', value: nextZ, raw: `Z${nextZ}` }
  return { ...line, words, raw: wordsToLine(words, line.comment) }
}
