import type { MachineState, ParsedLine } from './types'

export function createInitialState(): MachineState {
  return { units: 'mm', distanceMode: 'absolute', plane: 'G17', position: { x: 0, y: 0, z: 0 } }
}

export function getWord(line: ParsedLine, letter: string): number | undefined {
  return line.words.find((word) => word.letter === letter.toUpperCase())?.value
}

export function applyModalState(state: MachineState, line: ParsedLine): MachineState {
  const next: MachineState = { ...state, position: { ...state.position } }

  for (const word of line.words) {
    if (word.letter !== 'G') continue
    const g = `G${Math.trunc(word.value).toString().padStart(2, '0')}`
    if (g === 'G20') next.units = 'inch'
    if (g === 'G21') next.units = 'mm'
    if (g === 'G90') next.distanceMode = 'absolute'
    if (g === 'G91') next.distanceMode = 'incremental'
    if (g === 'G17') next.plane = 'G17'
    if (g === 'G18' || g === 'G19') next.plane = 'other'
    if (g === 'G00' || g === 'G01' || g === 'G02' || g === 'G03') next.motion = g
  }

  return next
}

export function updatePositionFromLine(state: MachineState, line: ParsedLine): MachineState {
  const next = applyModalState(state, line)

  for (const axis of ['X', 'Y', 'Z'] as const) {
    const value = getWord(line, axis)
    if (value === undefined) continue
    const key = axis.toLowerCase() as 'x' | 'y' | 'z'
    next.position[key] = next.distanceMode === 'incremental' ? next.position[key] + value : value
  }

  return next
}
