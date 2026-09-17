import { MaxRectsPacker, Rectangle } from 'maxrects-packer'
import type { Part } from '../models/Part'
import type { PackingEstimate, PackingPiece, PackingPlan, PackingSettings, PackingSize } from './types'

export const maxBoxLengthMm = 1200
export const packingDefaults = { paddingMm: 10, separatorMm: 2, wallMm: 5 }
const roundUp = (value: number) => Math.ceil((value - 1e-7) / 10) * 10
const volume = (size: PackingSize) => size.length * size.width * size.height / 1000000

export function packingPieces(parts: Part[], settings: PackingSettings = {}): PackingPiece[] {
  return parts.map(part => {
    const entered = settings.components?.[part.id]
    const header = part.gcode.match(/\(Material\s+(\d+(?:\.\d+)?)\s*mm\s*\//i)?.[1]
    const filename = part.originalFilename.match(/(?:^|[_ -])(\d+(?:\.\d+)?)\s*mm(?:[_ .-]|$)/i)?.[1]
    const hint = header ?? filename
    return {
      id: part.id, name: part.name,
      width: entered?.widthMm ?? part.width, height: entered?.heightMm ?? part.height,
      thickness: entered?.thicknessMm ?? (hint ? Number(hint) : 18),
      thicknessSource: entered?.thicknessMm !== undefined ? 'entered' : hint ? 'material hint' : 'assumed',
      footprintSource: entered?.widthMm !== undefined && entered?.heightMm !== undefined ? 'entered' : 'toolpath',
    }
  })
}

function dimensions(min: number, max: number, pieces: PackingPiece[], gap: number): number[] {
  const values = new Set([min, max])
  for (let value = Math.ceil(min / 50) * 50; value <= max; value += 50) values.add(value)
  const edges = [...new Set(pieces.flatMap(p => [p.width, p.height]))].sort((a, b) => a - b)
  for (const edge of edges) if (edge >= min && edge <= max) values.add(edge)
  for (const a of edges) for (const b of edges) if (a + b + gap >= min && a + b + gap <= max) values.add(a + b + gap)
  const sorted = [...values].sort((a, b) => a - b)
  // Bound the search while retaining exact single/pair fits and the endpoints.
  return sorted.length <= 36 ? sorted : Array.from({ length: 36 }, (_, i) => sorted[Math.round(i * (sorted.length - 1) / 35)])
}

export function estimatePacking(pieces: PackingPiece[], input: PackingSettings = {}): PackingEstimate {
  const settings = { paddingMm: input.paddingMm ?? packingDefaults.paddingMm, separatorMm: input.separatorMm ?? packingDefaults.separatorMm, wallMm: input.wallMm ?? packingDefaults.wallMm }
  const result: PackingEstimate = { pieces, plans: [], errors: [], warnings: [], settings, candidates: 0 }
  const { paddingMm: padding, separatorMm: gap, wallMm: wall } = settings
  if (![padding, gap, wall].every(n => Number.isFinite(n) && n >= 0 && n <= 50)) result.errors.push('Packaging allowances must be between 0 and 50 mm.')
  if (!pieces.length) result.errors.push('No components to pack.')
  if (pieces.length > 60) result.errors.push('Packing estimates support up to 60 components per item.')
  if (new Set(pieces.map(p => p.id)).size !== pieces.length) result.errors.push('Component identifiers must be unique.')
  for (const piece of pieces) {
    if (![piece.width, piece.height, piece.thickness].every(n => Number.isFinite(n) && n > 0)) result.errors.push(`${piece.name}: enter positive component dimensions.`)
  }
  const assumed = pieces.filter(p => p.thicknessSource === 'assumed').length
  if (assumed) result.warnings.push(`18 mm thickness assumed for ${assumed} component${assumed === 1 ? '' : 's'}; check component measurements.`)
  if (pieces.some(p => p.footprintSource === 'toolpath')) result.warnings.push('Toolpath footprints used; confirm finished dimensions and detached pieces.')
  if (pieces.some(p => p.thicknessSource === 'material hint')) result.warnings.push('Material thickness taken from program headers or filenames; verify stock thickness.')
  result.warnings.push('Flat-packed rectangles, one of every component. Loose hardware is not included. Best tested arrangement, not a guaranteed global optimum.')
  if (result.errors.length) return result
  const maxInternal = Math.floor((maxBoxLengthMm - wall * 2) / 10) * 10
  const maxFootprint = maxInternal - padding * 2
  for (const piece of pieces) if (Math.max(piece.width, piece.height) > maxFootprint || piece.thickness + padding * 2 > maxInternal) result.errors.push(`${piece.name} cannot fit flat within the 1,200 mm outside limit with these allowances.`)
  if (result.errors.length) return result
  const minLength = Math.max(...pieces.map(p => Math.max(p.width, p.height)))
  const minWidth = Math.max(...pieces.map(p => Math.min(p.width, p.height)))
  const lengths = dimensions(minLength, maxFootprint, pieces, gap)
  const widths = dimensions(minWidth, maxFootprint, pieces, gap)
  const plans = new Map<string, PackingPlan>()
  for (const length of lengths) for (const width of widths) {
    if (width > length) continue
    for (const order of ['area', 'edge', 'thickness'] as const) {
      result.candidates++
      const packer = new MaxRectsPacker(length, width, gap, { smart: false, pot: false, square: false, allowRotation: true })
      const sorted = [...pieces].sort((a, b) => (order === 'area' ? b.width * b.height - a.width * a.height : order === 'edge' ? Math.max(b.width, b.height) - Math.max(a.width, a.height) : b.thickness - a.thickness) || a.id.localeCompare(b.id))
      for (const piece of sorted) {
        const rect = new Rectangle(piece.width, piece.height)
        rect.data = piece
        packer.add(rect)
      }
      if (packer.bins.some(bin => bin.rects.some(rect => rect.oversized))) continue
      let z = padding, usedX = 0, usedY = 0
      const layers = packer.bins.map(bin => {
        const height = Math.max(...bin.rects.map(rect => (rect.data as PackingPiece).thickness))
        const layer = { height, z, parts: bin.rects.map(rect => {
          usedX = Math.max(usedX, rect.x + rect.width); usedY = Math.max(usedY, rect.y + rect.height)
          return { id: (rect.data as PackingPiece).id, x: rect.x + padding, y: rect.y + padding, width: rect.width, height: rect.height, rotated: rect.rot }
        }) }
        z += height + gap
        return layer
      })
      // Crop unused bin space, then round carton internal dimensions up to 10 mm.
      const internal = { length: roundUp(usedX + 2 * padding), width: roundUp(usedY + 2 * padding), height: roundUp(z - gap + padding) }
      if (Math.max(internal.length, internal.width, internal.height) > maxInternal) continue
      if (internal.width > internal.length) {
        [internal.length, internal.width] = [internal.width, internal.length]
        for (const layer of layers) for (const p of layer.parts) { [p.x, p.y] = [p.y, p.x]; [p.width, p.height] = [p.height, p.width]; p.rotated = !p.rotated }
      }
      const external = { length: internal.length + 2 * wall, width: internal.width + 2 * wall, height: internal.height + 2 * wall }
      const plan: PackingPlan = { internal, external, volumeLitres: volume(external), layers, rangeMax: { length: Math.min(maxInternal, internal.length + 20), width: Math.min(maxInternal, internal.width + 20), height: Math.min(maxInternal, internal.height + 20) } }
      const key = `${internal.length}/${internal.width}/${internal.height}`
      if (!plans.has(key)) plans.set(key, plan)
    }
  }
  const ranked = [...plans.values()].sort((a, b) => a.volumeLitres - b.volumeLitres || a.external.length - b.external.length || a.external.height - b.external.height)
  if (!ranked.length) { result.errors.push('No single-box flat-pack arrangement found within the 1,200 mm outside limit.'); return result }
  const best = ranked[0]
  const alternatives = ranked.filter(p => p.volumeLitres <= best.volumeLitres * 1.25)
  const low = [...alternatives].sort((a, b) => a.internal.height - b.internal.height || a.volumeLitres - b.volumeLitres)[0]
  const narrow = [...alternatives].sort((a, b) => a.internal.width - b.internal.width || a.volumeLitres - b.volumeLitres)[0]
  result.plans = [...new Set([best, low, narrow])]
  return result
}
