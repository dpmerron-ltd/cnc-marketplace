import type { ComponentSummary } from '../models/Part'
import type { PackingEstimate, PackingPiece, PackingPlan, PackingSettings, PackingSize } from './types'

export const maxBoxLengthMm = 1200
export const maxPartsPerBox = 5
export const packingDefaults = { paddingMm: 10, separatorMm: 2, wallMm: 5 }
const roundUp = (value: number) => Math.ceil((value - 1e-7) / 10) * 10
const volume = (size: PackingSize) => size.length * size.width * size.height / 1000000

export function packingPieces(parts: (ComponentSummary & { gcode?: string })[], settings: PackingSettings = {}): PackingPiece[] {
  return parts.map(part => {
    const entered = settings.components?.[part.id]
    const header = part.gcode?.match(/\(Material\s+(\d+(?:\.\d+)?)\s*mm\s*\//i)?.[1] ?? part.materialThicknessMm
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

function stackBox(pieces: PackingPiece[], settings: PackingEstimate['settings']): PackingPlan | undefined {
  if (!pieces.length || pieces.length > maxPartsPerBox) return undefined
  const { paddingMm: padding, separatorMm: gap, wallMm: wall } = settings
  const maxInternal = Math.floor((maxBoxLengthMm - wall * 2) / 10) * 10
  const internal = {
    length: roundUp(Math.max(...pieces.map(p => Math.max(p.width, p.height))) + 2 * padding),
    width: roundUp(Math.max(...pieces.map(p => Math.min(p.width, p.height))) + 2 * padding),
    height: roundUp(pieces.reduce((sum, p) => sum + p.thickness, 0) + (pieces.length - 1) * gap + 2 * padding),
  }
  if (Math.max(...Object.values(internal)) > maxInternal) return undefined
  const external = { length: internal.length + 2 * wall, width: internal.width + 2 * wall, height: internal.height + 2 * wall }
  let z = padding
  const layers = [...pieces].sort((a, b) => b.width * b.height - a.width * a.height || b.thickness - a.thickness || a.id.localeCompare(b.id)).map(piece => {
    const width = Math.max(piece.width, piece.height), height = Math.min(piece.width, piece.height)
    const layer = { height: piece.thickness, z, parts: [{ id: piece.id, x: (internal.length - width) / 2, y: (internal.width - height) / 2, width, height, rotated: piece.height > piece.width }] }
    z += piece.thickness + gap
    return layer
  })
  return { internal, external, volumeLitres: volume(external), layers, rangeMax: { length: Math.min(maxInternal, internal.length + 20), width: Math.min(maxInternal, internal.width + 20), height: Math.min(maxInternal, internal.height + 20) } }
}

const totalVolume = (boxes: PackingPlan[]) => boxes.reduce((sum, box) => sum + box.volumeLitres, 0)
const better = (candidate: PackingPlan[], current?: PackingPlan[]) => !current || candidate.length < current.length || candidate.length === current.length && totalVolume(candidate) < totalVolume(current) - 1e-7

function groupStacks(pieces: PackingPiece[], result: PackingEstimate): PackingPlan[] {
  const makeBox = (group: PackingPiece[]) => { result.candidates++; return stackBox(group, result.settings) }
  if (pieces.length <= 12) {
    // Exact set partitioning for small kits: fewest cartons first, then their total rounded volume.
    const groups = new Map<number, PackingPlan>()
    for (let mask = 1; mask < 1 << pieces.length; mask++) {
      const group = pieces.filter((_, i) => mask & (1 << i))
      if (group.length > maxPartsPerBox) continue
      const box = makeBox(group)
      if (box) groups.set(mask, box)
    }
    const memo = new Map<number, PackingPlan[]>([[0, []]])
    const solve = (mask: number): PackingPlan[] => {
      const cached = memo.get(mask)
      if (cached) return cached
      let best: PackingPlan[] | undefined
      const first = mask & -mask
      for (let subset = mask; subset; subset = (subset - 1) & mask) {
        if (!(subset & first)) continue
        const box = groups.get(subset)
        if (!box) continue
        const candidate = [box, ...solve(mask ^ subset)]
        if (better(candidate, best)) best = candidate
      }
      memo.set(mask, best!)
      return best!
    }
    return solve((1 << pieces.length) - 1)
  }
  let best: PackingPlan[] | undefined
  for (const order of ['area', 'length', 'width', 'thickness'] as const) {
    const score = (p: PackingPiece) => order === 'area' ? p.width * p.height : order === 'length' ? Math.max(p.width, p.height) : order === 'width' ? Math.min(p.width, p.height) : p.thickness
    const sorted = [...pieces].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
    const groups: PackingPiece[][] = [], boxes: PackingPlan[] = []
    for (const piece of sorted) {
      let index = -1, chosen: PackingPlan | undefined, extraVolume = Infinity
      for (let i = 0; i < groups.length; i++) {
        const box = makeBox([...groups[i], piece])
        if (box && box.volumeLitres - boxes[i].volumeLitres < extraVolume) { index = i; chosen = box; extraVolume = box.volumeLitres - boxes[i].volumeLitres }
      }
      if (index < 0) { groups.push([piece]); boxes.push(makeBox([piece])!) }
      else { groups[index].push(piece); boxes[index] = chosen! }
    }
    if (better(boxes, best)) best = boxes
  }
  return best!
}

export function estimatePacking(pieces: PackingPiece[], input: PackingSettings = {}): PackingEstimate {
  const settings = { paddingMm: input.paddingMm ?? packingDefaults.paddingMm, separatorMm: input.separatorMm ?? packingDefaults.separatorMm, wallMm: input.wallMm ?? packingDefaults.wallMm }
  const result: PackingEstimate = { pieces, boxes: [], errors: [], warnings: [], settings, candidates: 0 }
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
  result.warnings.push('One component per layer, at most five per box. Loose hardware is not included.')
  if (pieces.length > 12) result.warnings.push('Best tested grouping for this large kit; not a guaranteed global optimum.')
  if (result.errors.length) return result
  const maxInternal = Math.floor((maxBoxLengthMm - wall * 2) / 10) * 10
  const maxFootprint = maxInternal - padding * 2
  for (const piece of pieces) if (Math.max(piece.width, piece.height) > maxFootprint || piece.thickness + padding * 2 > maxInternal) result.errors.push(`${piece.name} cannot fit flat within the 1,200 mm outside limit with these allowances.`)
  if (result.errors.length) return result
  result.boxes = groupStacks(pieces, result).sort((a, b) => b.volumeLitres - a.volumeLitres)
  return result
}
