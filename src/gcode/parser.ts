import type { DistanceMode, GCodeWord, MotionCommand, ParsedLine, ParsedProgram, Units } from './types'
import { controllerStartBegin, controllerStartEnd, controllerStartWarnings, hasControllerStart, validateControllerStart } from './controllerStart'

const wordPattern = /([A-Za-z])([+-]?(?:\d+\.?\d*|\.\d+))/g

function normalizeG(value: number): string {
  return `G${Math.trunc(value).toString().padStart(2, '0')}`
}

function normalizeM(value: number): string {
  return `M${Math.trunc(value).toString().padStart(2, '0')}`
}

function splitComment(raw: string): { body: string; comment?: string } {
  const parenIndex = raw.indexOf('(')
  const semiIndex = raw.indexOf(';')
  const candidates = [parenIndex, semiIndex].filter((index) => index >= 0)
  if (candidates.length === 0) return { body: raw }
  const first = Math.min(...candidates)
  return { body: raw.slice(0, first), comment: raw.slice(first).trim() }
}

function isMotion(command: string): command is MotionCommand {
  return command === 'G00' || command === 'G01' || command === 'G02' || command === 'G03'
}

export function parseLine(raw: string, lineNumber: number): ParsedLine {
  const { body, comment } = splitComment(raw)
  const words: GCodeWord[] = []
  const warnings: string[] = []
  let match: RegExpExecArray | null

  wordPattern.lastIndex = 0
  while ((match = wordPattern.exec(body)) !== null) {
    words.push({ letter: match[1].toUpperCase(), value: Number(match[2]), raw: match[0] })
  }

  const commandWord = words.find((word) => word.letter === 'G' || word.letter === 'M')
  const command =
    commandWord?.letter === 'G'
      ? normalizeG(commandWord.value)
      : commandWord?.letter === 'M'
        ? normalizeM(commandWord.value)
        : undefined

  if (body.trim() && words.length === 0) warnings.push(`Line ${lineNumber + 1}: no parseable G-code words found.`)
  return { lineNumber, raw, words, comment, command, warnings }
}

export function parseGCode(source: string): ParsedProgram {
  const lines = source.replace(/\r\n/g, '\n').split('\n').map(parseLine)
  const warnings: string[] = []
  let controllerHeaderEnd = -1
  const markers = lines.filter(line => [controllerStartBegin, controllerStartEnd].includes(line.raw.trim()))
  if (markers.length) {
    const [begin, end] = markers
    const code = end ? lines.slice(begin.lineNumber + 1, end.lineNumber).map(line => line.raw).join('\n') : ''
    const prefixSafe = lines.slice(0, begin.lineNumber).every(line => !line.words.length || line.words.every(word => word.letter === 'G' && [21, 17, 90, 94].includes(word.value) || word.letter === 'M' && word.value === 5))
    const reset = end ? lines.slice(end.lineNumber + 1, end.lineNumber + 7).map(line => line.raw.trim()) : []
    const resetSafe = reset.slice(0, 5).join('\n') === 'G21\nG17\nG90\nG94\nM05' && /^G00 Z\d+(?:\.\d+)?$/.test(reset[5] ?? '') && Number(reset[5]?.slice(5)) > 0
    if (markers.length === 2 && begin.raw.trim() === controllerStartBegin && end.raw.trim() === controllerStartEnd && prefixSafe && resetSafe && hasControllerStart(code) && !validateControllerStart(code).length) {
      controllerHeaderEnd = end.lineNumber
      // Macros and probing execute externally. Preserve source lines but exclude them from machining geometry.
      for (const line of lines.slice(begin.lineNumber, end.lineNumber + 1)) {
        line.words = []; line.command = undefined; line.warnings = []
      }
      warnings.push(...controllerStartWarnings(code))
    } else {
      begin.unsupportedForTransform = 'Invalid controller startup block'
      warnings.push('Invalid controller startup block; export is blocked.')
    }
  }
  let units: Units | 'unknown' = 'unknown'
  let distanceMode: DistanceMode | 'unknown' = 'unknown'
  let modalMotion: MotionCommand | undefined

  for (const line of lines) {
    for (const word of line.words) {
      if (word.letter !== 'G') continue
      const g = normalizeG(word.value)
      if (g === 'G20') units = 'inch'
      if (g === 'G21') units = 'mm'
      if (g === 'G90') distanceMode = 'absolute'
      if (g === 'G91') {
        distanceMode = 'incremental'
      }
      if (g === 'G18' || g === 'G19') {
        const warning = `Line ${line.lineNumber + 1}: only G17 XY plane arcs are supported for transformation.`
        warnings.push(warning)
        line.warnings.push(warning)
        line.unsupportedForTransform = `${g} non-XY plane`
      }
      if (isMotion(g)) {
        modalMotion = g
        line.command = g
      }
    }

    const hasAxis = line.words.some((word) => ['X', 'Y', 'Z', 'I', 'J'].includes(word.letter))
    if (line.command && isMotion(line.command)) line.effectiveMotion = line.command
    else if (hasAxis && modalMotion) line.effectiveMotion = modalMotion
    warnings.push(...line.warnings)
  }

  const firstMotionIndex = lines.findIndex((line) => line.effectiveMotion === 'G01' || line.effectiveMotion === 'G02' || line.effectiveMotion === 'G03')
  let bodyStart = firstMotionIndex >= 0 ? firstMotionIndex : controllerHeaderEnd + 1
  for (let index = bodyStart - 1; index > controllerHeaderEnd; index -= 1) {
    if (lines[index].raw.trim().match(/^\(No\.\s*\d+\s+.+\)$/i)) {
      bodyStart = index
      break
    }
  }
  const lastMotionIndex = lines.findLastIndex(line => line.effectiveMotion === 'G01' || line.effectiveMotion === 'G02' || line.effectiveMotion === 'G03')
  // Startup stops and intermediate spindle pauses are not program footers.
  const endIndex = lines.findIndex((line, index) => index > bodyStart && line.words.some(word => {
    if (word.letter !== 'M') return false
    const m = Math.trunc(word.value)
    return m === 2 || m === 30 || (m === 5 && index > lastMotionIndex)
  }))
  const bodyEnd = endIndex >= 0 && endIndex > bodyStart ? endIndex : lines.length

  return { lines, warnings, units, distanceMode, startLines: lines.slice(0, bodyStart), bodyLines: lines.slice(bodyStart, bodyEnd), endLines: lines.slice(bodyEnd) }
}
