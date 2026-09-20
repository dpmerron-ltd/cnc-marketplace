import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import { validateSheet } from '../gcode/validator'
import { autoNest } from './nestingEngine'

self.onmessage = (event: MessageEvent<{ parts: Part[]; sheet: Sheet }>) => {
  try {
    const { parts, sheet } = event.data
    const instances = autoNest(parts, sheet, (completed, total) => self.postMessage({ progress: { completed, total } }))
    const errors = validateSheet(parts, { ...sheet, instances }).filter(issue => issue.level === 'error')
    if (errors.length) throw new Error(errors.map(error => error.message).join(' '))
    self.postMessage({ instances })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Auto nesting failed.' })
  }
}
