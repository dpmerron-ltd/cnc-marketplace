import type { GCodeWord } from './types'

const wordOrder = ['G', 'M', 'X', 'Y', 'Z', 'I', 'J', 'K', 'F', 'S']

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Cannot format non-finite number: ${value}`)
  return value.toFixed(4).replace(/\.?0+$/, '')
}

export function formatWord(letter: string, value: number): string {
  const normalizedLetter = letter.toUpperCase()
  if ((normalizedLetter === 'G' || normalizedLetter === 'M') && Number.isInteger(value)) {
    return `${normalizedLetter}${value.toString().padStart(2, '0')}`
  }
  return `${normalizedLetter}${formatNumber(value)}`
}

export function wordsToLine(words: GCodeWord[], comment?: string): string {
  const orderedWords = [...words].sort((a, b) => {
    const aIndex = wordOrder.indexOf(a.letter)
    const bIndex = wordOrder.indexOf(b.letter)
    return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex)
  })
  const body = orderedWords.map((word) => formatWord(word.letter, word.value)).join(' ')
  if (comment && body) return `${body} ${comment}`
  return body || comment || ''
}
