import { MaxRectsBin } from 'maxrects-packer'
import { packingDefaults } from './packing'
import type { BoxStock } from './boxStock'
import type { PackingEstimate, PackingPiece, PackingPlan, PackingSettings, PackingSize } from './types'

const round = (n: number) => Math.ceil((n - 1e-7) / 10) * 10
const volume = (s: PackingSize) => s.length * s.width * s.height / 1e6
const count = (p: PackingPlan) => p.layers.reduce((n, l) => n + l.parts.length, 0)
const usedHeight = (p: PackingPlan) => Math.max(...p.layers.map(l => l.z + l.height))

function layout(pieces: PackingPiece[], size: PackingSize, settings: PackingEstimate['settings'], sort: 'area' | 'thickness' | 'length'): PackingPlan | undefined {
  const { paddingMm: pad, separatorMm: gap, wallMm: wall } = settings
  const w = size.length - 2 * pad, h = size.width - 2 * pad
  if (w <= 0 || h <= 0 || size.height <= 2 * pad) return
  const score = (p: PackingPiece) => sort === 'area' ? p.width * p.height : sort === 'length' ? Math.max(p.width, p.height) : p.thickness
  const sorted = [...pieces].sort((a, b) => score(b) - score(a) || b.thickness - a.thickness || a.id.localeCompare(b.id))
  const bins: { bin: MaxRectsBin; height: number }[] = []
  let stackHeight = 0
  for (const piece of sorted) {
    let placed = false
    for (const layer of bins) {
      if (piece.thickness <= layer.height && layer.bin.add(piece.width, piece.height, { id: piece.id })) { placed = true; break }
    }
    if (placed || stackHeight + (bins.length ? gap : 0) + piece.thickness > size.height - 2 * pad + 1e-7) continue
    const bin = new MaxRectsBin(w, h, gap, { smart: false, pot: false, square: false, allowRotation: true })
    if (!bin.add(piece.width, piece.height, { id: piece.id })) continue
    stackHeight += (bins.length ? gap : 0) + piece.thickness
    bins.push({ bin, height: piece.thickness })
  }
  if (!bins.length) return
  let z = pad
  const layers = bins.map(({ bin, height }) => {
    const layer = { height, z, parts: bin.rects.map(r => ({ id: r.data.id as string, x: pad + r.x, y: pad + r.y, width: r.width, height: r.height, rotated: r.rot })) }
    z += height + gap
    return layer
  })
  const external = { length: size.length + 2 * wall, width: size.width + 2 * wall, height: size.height + 2 * wall }
  return { internal: size, external, rangeMax: size, layers, volumeLitres: volume(external) }
}

function bestLayout(pieces: PackingPiece[], size: PackingSize, result: PackingEstimate) {
  let best: PackingPlan | undefined
  for (const sort of ['thickness', 'area', 'length'] as const) {
    result.candidates++
    const plan = layout(pieces, size, result.settings, sort)
    if (plan && (!best || count(plan) > count(best) || count(plan) === count(best) && usedHeight(plan) < usedHeight(best))) best = plan
  }
  return best
}

function stockCandidates(pieces: PackingPiece[], boxes: BoxStock[], result: PackingEstimate) {
  return boxes.flatMap(box => {
    const stockInternal = { length: box.length_mm, width: box.width_mm, height: box.height_mm }
    // Turning the carton on its side can fit wider panels without changing its stock size.
    return [stockInternal, { length: box.length_mm, width: box.height_mm, height: box.width_mm }].flatMap(size => {
      const plan = bestLayout(pieces, size, result)
      return plan ? [{ ...plan, stockId: box.id, stockName: box.name, stockQuantity: box.quantity, stockInternal }] : []
    })
  })
}

function shortage(plans: PackingPlan[]) {
  const used = new Map<string, number>()
  for (const plan of plans) used.set(plan.stockId!, (used.get(plan.stockId!) ?? 0) + 1)
  return [...used].reduce((sum, [id, n]) => sum + Math.max(0, n - (plans.find(p => p.stockId === id)?.stockQuantity ?? 0)), 0)
}
function better(plans: PackingPlan[], previous?: PackingPlan[]) {
  return !previous || plans.length < previous.length || plans.length === previous.length && (shortage(plans) < shortage(previous) || shortage(plans) === shortage(previous) && plans.reduce((s, p) => s + p.volumeLitres, 0) < previous.reduce((s, p) => s + p.volumeLitres, 0))
}

export function estimateStockPacking(pieces: PackingPiece[], input: PackingSettings = {}, stock: BoxStock[] = []): PackingEstimate {
  const settings = { paddingMm: input.paddingMm ?? packingDefaults.paddingMm, separatorMm: input.separatorMm ?? packingDefaults.separatorMm, wallMm: input.wallMm ?? packingDefaults.wallMm }
  const result: PackingEstimate = { pieces, settings, boxes: [], warnings: [], errors: [], candidates: 0 }
  if (!Object.values(settings).every(n => Number.isFinite(n) && n >= 0 && n <= 50)) result.errors.push('Packaging allowances must be between 0 and 50 mm.')
  if (!pieces.length || pieces.length > 60) result.errors.push('Packing requires between 1 and 60 components.')
  if (new Set(pieces.map(p => p.id)).size !== pieces.length) result.errors.push('Component identifiers must be unique.')
  for (const piece of pieces) if (![piece.width, piece.height, piece.thickness].every(n => Number.isFinite(n) && n > 0 && n <= 1200)) result.errors.push(`${piece.name}: verify dimensions; maximum supported dimension is 1,200 mm.`)
  if (stock.length > 50 || stock.some(b => ![b.length_mm, b.width_mm, b.height_mm].every(n => Number.isFinite(n) && n >= 10 && n <= 1200) || !Number.isInteger(b.quantity) || b.quantity < 0)) result.errors.push('Invalid box stock dimensions or counts.')
  if (result.errors.length) return result
  if (pieces.some(p => p.thicknessSource === 'assumed')) result.warnings.push('Some thicknesses are assumed to be 18 mm; confirm actual components.')
  if (pieces.some(p => p.footprintSource === 'toolpath')) result.warnings.push('Toolpath bounds used; confirm finished dimensions and detached pieces.')
  result.warnings.push('Flat panels may share layers or stack. Support thinner panels and overhangs with inserts. Hardware, weight and carton strength require a trial pack.')
  result.warnings.push('Best tested layout, not a guaranteed optimum. Dimensions of stocked boxes are internal; their outside length may exceed 120 cm.')

  const candidates = stockCandidates(pieces, stock, result)
  let best: PackingPlan[] | undefined
  for (const plan of candidates) if (count(plan) === pieces.length && better([plan], best)) best = [plan]
  if (!best) for (const first of [...candidates].sort((a, b) => count(b) - count(a) || a.volumeLitres - b.volumeLitres).slice(0, 12)) {
    const packed = new Set(first.layers.flatMap(l => l.parts.map(p => p.id)))
    const remaining = pieces.filter(p => !packed.has(p.id))
    for (const second of stockCandidates(remaining, stock, result)) if (count(second) === remaining.length && better([first, second], best)) best = [first, second]
  }

  // Suggest a compact, complete single carton independently of current inventory.
  const pad = 2 * settings.paddingMm
  const minLength = round(Math.max(...pieces.map(p => Math.max(p.width, p.height))) + pad)
  const minWidth = round(Math.max(...pieces.map(p => Math.min(p.width, p.height))) + pad)
  const lengths = [...new Set([minLength, 1050, 1200])].filter(n => n >= minLength && n <= 1200)
  const widths = [...new Set([minWidth, 350, 400, 500, 600])].filter(n => n >= minWidth && n <= 1200)
  for (const length of lengths) for (const width of widths) {
    const plan = bestLayout(pieces, { length, width, height: 1200 }, result)
    if (!plan || count(plan) !== pieces.length) continue
    const all = plan.layers.flatMap(l => l.parts)
    const internal = { length: round(Math.max(...all.map(p => p.x + p.width)) + settings.paddingMm), width: round(Math.max(...all.map(p => p.y + p.height)) + settings.paddingMm), height: round(usedHeight(plan) + settings.paddingMm) }
    const external = { length: internal.length + 2 * settings.wallMm, width: internal.width + 2 * settings.wallMm, height: internal.height + 2 * settings.wallMm }
    const suggestion = { ...plan, internal, external, volumeLitres: volume(external), rangeMax: { length: Math.min(1200, internal.length + 20), width: Math.min(1200, internal.width + 20), height: Math.min(1200, internal.height + 20) } }
    if (!result.suggestedBox || suggestion.volumeLitres < result.suggestedBox.volumeLitres) result.suggestedBox = suggestion
  }
  if (best) {
    result.boxes = best
    if (shortage(best)) result.warnings.push(`Replenish ${shortage(best)} box(es) of the selected size before packing; estimates do not reserve stock.`)
  } else if (result.suggestedBox) {
    result.boxes = [result.suggestedBox]
    result.warnings.push('No tested one- or two-box layout fits the stocked sizes. A new carton size is required for this suggested single-box layout.')
  } else result.errors.push('No complete packing layout found within the 120 cm internal-size limit. Review the measurements or split the kit.')
  return result
}
