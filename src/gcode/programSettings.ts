import { parseLine } from './parser'
import { getWord } from './state'
import { controllerStartBegin, controllerStartEnd, hasControllerStart, validateControllerStart } from './controllerStart'

export interface ProgramSettings {
  startGcode: string
  spindleStartGcode: string
  endGcode: string
}

export const defaultProgramSettings: ProgramSettings = {
  startGcode: 'G21\nG17\nG90\nG94',
  spindleStartGcode: 'S18000 M03',
  endGcode: 'M05\nM30',
}

export const programLines = (code: string) => code.split('\n').filter(line => line.trim())
export function normalizePrograms(value: ProgramSettings): ProgramSettings {
  return Object.fromEntries(Object.keys(defaultProgramSettings).map(key => {
    const code = value[key as keyof ProgramSettings]
    if (typeof code !== 'string') throw new Error('All three program fields are required.')
    return [key, code.replace(/\r\n?/g, '\n').trim()]
  })) as unknown as ProgramSettings
}

export function validatePrograms(value: ProgramSettings, safeZ = 20): string[] {
  const errors: string[] = []
  for (const key of Object.keys(defaultProgramSettings) as Array<keyof ProgramSettings>) {
    const label = { startGcode: 'Start program', spindleStartGcode: 'Spindle start', endGcode: 'End program' }[key]
    const code = value[key]
    if (typeof code !== 'string' || !code.trim() || code.length > 8000 || code.split('\n').length > 100) {
      errors.push(`${label}: enter 1-100 lines, at most 8,000 characters.`); continue
    }
    if (code.includes(controllerStartBegin) || code.includes(controllerStartEnd)) errors.push(`${label}: reserved controller block marker.`)
    if (key === 'startGcode' && hasControllerStart(code)) {
      errors.push(...validateControllerStart(code)); continue
    }
    let spindle = false, speed = 0, stopped = false, terminated = false
    for (const [index, raw] of code.split('\n').entries()) {
      const fail = (message: string) => errors.push(`${label}, line ${index + 1}: ${message}`)
      if (/\)[^;(]*[A-Za-z0-9]/.test(raw.split(';')[0])) fail('Put comments on their own line or after all commands.')
      const body = raw.split(';')[0].replace(/\([^()]*\)/g, ' ').trim()
      if (!body) continue
      const line = parseLine(body, index)
      if (body.replace(/[A-Za-z][+-]?(?:\d+\.?\d*|\.\d+)/g, '').trim() || /[^\x20-\x7e\t]/.test(raw)) { fail('Unsupported syntax or unbalanced comment.'); continue }
      if (terminated) { fail('No commands may follow M02/M30.'); continue }
      const gs = line.words.filter(w => w.letter === 'G').map(w => w.value)
      const ms = line.words.filter(w => w.letter === 'M').map(w => w.value)
      const allowedG = key === 'spindleStartGcode' ? [4] : key === 'startGcode' ? [0, 4, 17, 21, 40, 49, 54, 55, 56, 57, 58, 59, 80, 90, 94] : [0, 4, 17, 21, 90, 94]
      const allowedM = key === 'spindleStartGcode' ? [3, 5, 7, 8, 9] : key === 'endGcode' ? [0, 1, 2, 5, 7, 8, 9, 30] : [0, 1, 5, 7, 8, 9]
      if (gs.some(g => !allowedG.includes(g)) || ms.some(m => !allowedM.includes(m))) fail('Unsupported command. Keep metric/absolute modes; machining, homing, offsets and early program stops cannot be inserted here.')
      if (gs.includes(0) && gs.includes(4)) fail('Separate rapid motion and dwell commands.')
      for (const word of line.words) {
        if (!Number.isFinite(word.value)) { fail('Values must be finite.'); continue }
        if (['G', 'M', 'N'].includes(word.letter)) continue
        if (['X', 'Y', 'Z'].includes(word.letter) && key !== 'spindleStartGcode' && gs.includes(0)) {
          if (Math.abs(word.value) > 10000 || word.letter === 'Z' && word.value < safeZ) fail(`Program moves must keep Z at or above safe Z ${safeZ} mm and coordinates within 10,000 mm.`)
        } else if (word.letter === 'P' && gs.includes(4) && word.value >= 0 && word.value <= 600) {
          // Controller dwell units remain an operator-reviewed program setting.
        } else if (word.letter === 'S' && key === 'spindleStartGcode' && word.value > 0 && word.value <= 100000) speed = word.value
        else fail(`Unsupported ${word.letter} word in this program block.`)
      }
      if (gs.includes(4) && getWord(line, 'P') === undefined) fail('Dwell requires P.')
      for (const m of ms) {
        if (m === 3) spindle = true
        if (m === 5) { spindle = false; stopped = true }
        if (m === 2 || m === 30) {
          if (!stopped) fail('Stop the spindle with M05 before ending the program.')
          terminated = true
          if (line.words.at(-1)?.letter !== 'M' || line.words.at(-1)?.value !== m) fail('M02/M30 must be the last command.')
        }
      }
    }
    if (key === 'spindleStartGcode' && (!spindle || !speed)) errors.push('Spindle start must set a positive S speed and leave M03 active.')
    if (key === 'endGcode' && !terminated) errors.push('End program must finish with M02 or M30 after M05.')
  }
  return [...new Set(errors)]
}

export function spindleRpm(programs: ProgramSettings): number {
  return programLines(programs.spindleStartGcode).flatMap((line, i) => parseLine(line, i).words).filter(w => w.letter === 'S').at(-1)?.value ?? 0
}

export function startProgramLines(programs: ProgramSettings, safeZ: number): string[] {
  if (hasControllerStart(programs.startGcode)) {
    return ['G21', 'G17', 'G90', 'G94', 'M05', controllerStartBegin, ...programLines(programs.startGcode), controllerStartEnd, 'G21', 'G17', 'G90', 'G94', 'M05', `G00 Z${safeZ}`]
  }
  return ['G21', 'G17', 'G90', 'G94', 'M05', `G00 Z${safeZ}`, ...programLines(programs.startGcode), 'G21', 'G17', 'G90', 'G94', `G00 Z${safeZ}`]
}
