import type { Part } from '../models/Part'
import { createInitialState, updatePositionFromLine } from './state'

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
