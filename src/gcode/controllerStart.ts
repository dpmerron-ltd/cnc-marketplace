export const controllerStartBegin = '(CNC CONTROLLER START BEGIN)'
export const controllerStartEnd = '(CNC CONTROLLER START END)'

interface Word { letter: string; value: number | string }

// Controller messages use quoted strings, including doubled quotes and comment characters.
function tokenize(raw: string): Word[] {
  if (/[^\x20-\x7e\t]/.test(raw) || raw.length > 255) throw new Error('Use ASCII lines of at most 255 characters.')
  const words: Word[] = []
  let rest = raw.trim()
  while (rest) {
    if (rest.startsWith(';')) break
    if (rest.startsWith('(')) {
      const comment = /^\([^()]*\)/.exec(rest)
      if (!comment) throw new Error('Unbalanced comment.')
      rest = rest.slice(comment[0].length).trimStart(); continue
    }
    const match = /^([A-Za-z])("(?:[^"]|"")*"|[+-]?(?:\d+\.?\d*|\.\d+))/.exec(rest)
    if (!match) throw new Error('Unsupported syntax or unbalanced quote.')
    const value = match[2].startsWith('"') ? match[2].slice(1, -1).replaceAll('""', '"') : Number(match[2])
    words.push({ letter: match[1].toUpperCase(), value })
    rest = rest.slice(match[0].length).trimStart()
  }
  return words
}

export function hasControllerStart(code: string): boolean {
  return code.split('\n').some(raw => {
    try { return tokenize(raw).some(w => w.letter === 'M' && [98, 291, 400, 563, 585].includes(Number(w.value))) }
    catch { return /^\s*M(?:98|291|400|563|585)\b/i.test(raw) }
  })
}

export function validateControllerStart(code: string): string[] {
  const errors: string[] = []
  if (!code.trim() || code.length > 8000 || code.split('\n').length > 100) return ['Start program: enter 1-100 lines, at most 8,000 characters.']
  code.split('\n').forEach((raw, index) => {
    const fail = (message: string) => errors.push(`Start program, line ${index + 1}: ${message}`)
    try {
      if (raw.includes(controllerStartBegin) || raw.includes(controllerStartEnd)) throw new Error('Reserved controller block marker.')
      const words = tokenize(raw)
      if (!words.length) return
      const [command, ...args] = words
      const is = (letter: string, ...values: number[]) => command.letter === letter && typeof command.value === 'number' && values.includes(command.value)
      const get = (letter: string) => args.find(w => w.letter === letter)?.value
      const num = (letter: string, min: number, max: number, integer = false) => {
        const value = get(letter)
        return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))
      }
      const optional = (letter: string, min: number, max: number, integer = false) => get(letter) === undefined || num(letter, min, max, integer)
      const string = (letter: string, max: number) => typeof get(letter) === 'string' && (get(letter) as string).length > 0 && (get(letter) as string).length <= max
      let allowed = '', valid = false
      if (is('M', 98)) { allowed = 'P'; valid = string('P', 200) }
      else if (is('M', 400, 5, 7, 8, 9, 0, 1)) valid = true
      else if (is('M', 291)) {
        allowed = 'PRSTXYZ'; valid = string('P', 249) && (get('R') === undefined || string('R', 60)) && optional('S', 0, 3, true) && optional('T', 0, 600) && ['X', 'Y', 'Z'].every(axis => optional(axis, 0, 1, true))
      } else if (is('M', 563)) {
        allowed = 'PSDH'; valid = num('P', 0, 65535, true) && ((string('S', 60) && get('D') === undefined && get('H') === undefined) || (get('S') === undefined && get('D') === -1 && get('H') === -1))
      } else if (is('T', -1) || command.letter === 'T' && typeof command.value === 'number' && Number.isInteger(command.value) && command.value >= 0 && command.value <= 65535) valid = true
      else if (is('M', 585)) {
        allowed = 'ZFSELPR'
        valid = num('Z', -1000, 1000) && num('F', 1, 10000) && optional('S', 0, 1, true) && optional('E', 0, 255, true) && optional('L', 0, 1, true) && optional('P', 0, 255, true) && optional('R', 0, 1000) && (get('L') === undefined || get('E') !== undefined) && !(get('P') !== undefined && get('E') !== undefined)
      } else if (is('G', 10)) { allowed = 'LZP'; valid = get('L') === 20 && num('Z', 0, 1000) && optional('P', 1, 9, true) }
      else if (is('G', 0, 1)) { allowed = 'ZF'; valid = num('Z', 0.001, 1000) && optional('F', 1, 10000) }
      else if (is('G', 4)) { allowed = 'P'; valid = num('P', 0, 600) }
      else if (is('M', 3)) { allowed = 'S'; valid = num('S', 1, 100000) }
      else if (is('G', 17, 21, 40, 49, 54, 55, 56, 57, 58, 59, 80, 90, 91, 94)) {
        allowed = 'G'; valid = args.every(w => w.letter === 'G' && [17, 21, 40, 49, 54, 55, 56, 57, 58, 59, 80, 90, 91, 94].includes(Number(w.value)))
      }
      if (!valid || args.some(w => !allowed.includes(w.letter)) || allowed !== 'G' && new Set(args.map(w => w.letter)).size !== args.length) {
        fail('Unsupported Duet startup command or parameters. Only setup, macros, prompts, Z probing/retraction and spindle setup are allowed.')
      }
    } catch (error) { fail((error as Error).message) }
  })
  return errors
}

export function controllerStartWarnings(code: string): string[] {
  if (!hasControllerStart(code)) return []
  const commands = code.split('\n').flatMap(raw => { try { return [tokenize(raw)] } catch { return [] } })
  const has = (m: number) => commands.some(words => words[0]?.letter === 'M' && words[0].value === m)
  const warnings = ['Duet startup runs on the controller and is not simulated. Verify the macro contents, probing, tool setup and final work zero on the machine before cutting.']
  if (has(98) && has(585)) warnings.push('Startup contains both a macro call and inline probing. If the macro probes, this will probe twice; keep only the intended cycle.')
  if (commands.some(words => words[0]?.value === 585 && words.some(w => ['E', 'L'].includes(w.letter)) || words[0]?.letter === 'T' && Number(words[0].value) > 49 || words[0]?.value === 563 && words.some(w => w.letter === 'P' && Number(w.value) > 49))) warnings.push('This startup uses legacy RepRapFirmware 2 probe/tool parameters. Verify compatibility with the installed firmware version.')
  return warnings
}
