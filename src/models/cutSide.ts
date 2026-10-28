import type { Part } from './Part'
import type { Sheet } from './Sheet'

export const cutSides = ['either', 'pattern', 'non-pattern'] as const
export type CutSide = typeof cutSides[number]
export type SheetCutSide = CutSide | 'mixed'

export function cutSideLabel(side: SheetCutSide | undefined): string {
  switch (side) {
    case 'pattern': return 'Pattern side up'
    case 'non-pattern': return 'Non-pattern side up'
    case 'mixed': return 'Conflicting cutting sides'
    default: return 'Either side'
  }
}

export function compatibleCutSides(a: CutSide | undefined, b: CutSide | undefined): boolean {
  return !a || a === 'either' || !b || b === 'either' || a === b
}

export function sheetCutSide(parts: Pick<Part, 'id' | 'cutSide'>[], sheet: Pick<Sheet, 'instances'>, index: number): SheetCutSide {
  const byId = new Map(parts.map(part => [part.id, part.cutSide]))
  const sides = new Set(sheet.instances.filter(instance => instance.sheetIndex === index)
    .map(instance => byId.get(instance.partId)).filter(side => side && side !== 'either'))
  return sides.size > 1 ? 'mixed' : sides.values().next().value ?? 'either'
}

export function cutSideErrors(parts: Part[], sheet: Pick<Sheet, 'instances'>): string[] {
  const used = new Set(sheet.instances.map(instance => instance.partId))
  const errors = parts.filter(part => used.has(part.id) && part.cutSide !== undefined && !cutSides.includes(part.cutSide))
    .map(part => `${part.name}: unknown cutting side. Choose either side, pattern side up or non-pattern side up.`)
  for (const index of new Set(sheet.instances.map(instance => instance.sheetIndex))) {
    if (sheetCutSide(parts, sheet, index) === 'mixed') errors.push(`Sheet ${index + 1} mixes pattern-side-up and non-pattern-side-up components. Move them onto separate sheets or auto-nest before exporting.`)
  }
  return errors
}
