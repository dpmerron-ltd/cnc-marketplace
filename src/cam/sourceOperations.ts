import type { CamDrawing, OperationKind, OperationOverride } from './types'

/** Candidates only: callers must reproduce and compare the complete NC before using them. */
export function recordedOperations(gcode: string, drawing: CamDrawing): Record<string, OperationOverride> | undefined {
  if (!gcode.includes('(DXF CAM -')) return
  const blocks = [...gcode.matchAll(/\(No\. \d+ (outside|inside|drill|pocket) machining:[^\n]*\)\r?\n\(Feature: ([^ /]+) \/ Layer: [^\n]*\)/g)]
  if (!blocks.length) return
  const operations: Record<string, OperationOverride> = Object.fromEntries(drawing.features.map(f => [f.id, { kind: 'ignore' }]))
  const seen = new Set<string>()
  for (const [i, block] of blocks.entries()) {
    const kind = block[1] as OperationKind, id = block[2]
    if (!Object.hasOwn(operations, id) || seen.has(id)) return
    seen.add(id)
    const code = gcode.slice(block.index! + block[0].length, blocks[i + 1]?.index ?? gcode.length)
    const depth = Math.max(0, ...[...code.matchAll(/\bZ(-?\d+(?:\.\d+)?)/g)].map(m => -Number(m[1])))
    const tabs = new Set([...code.matchAll(/\(Tab (\d+)\)/g)].map(m => m[1])).size
    operations[id] = { kind, ...(['pocket', 'drill'].includes(kind) ? { depthMm: depth } : { tabs, ...(kind === 'inside' ? { cornerOvercuts: code.includes('(Automatic corner overcuts:') } : {}) }) }
  }
  return operations
}
