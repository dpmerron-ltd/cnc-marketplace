import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import type { Bounds, Point } from '../models/geometry'
import { isFiniteBounds } from '../models/geometry'
import { preparationBounds } from './preparationBounds'

export const screwMarkDepthMm = 2
export const screwMarkFeedMmPerMinute = 300
export const screwClearanceMm = 10
const edgeInsetMm = 10
const targetSpacingMm = 150
const maximumMarks = 8

export interface ScrewPositionPlan {
  points: Point[]
  errors: string[]
  warnings: string[]
}

export function distanceToBounds(point: Point, bounds: Bounds): number {
  return Math.hypot(
    Math.max(bounds.minX - point.x, 0, point.x - bounds.maxX),
    Math.max(bounds.minY - point.y, 0, point.y - bounds.maxY),
  )
}

function axisCandidates(maximum: number, intervals: Array<[number, number]>): number[] {
  const limit = maximum - edgeInsetMm
  if (limit < edgeInsetMm) return []
  const values = new Set<number>([edgeInsetMm, limit])
  const divisions = Math.max(1, Math.ceil((limit - edgeInsetMm) / targetSpacingMm))
  for (let index = 1; index < divisions; index++) values.add(edgeInsetMm + (limit - edgeInsetMm) * index / divisions)
  const edges = intervals.flat().sort((a, b) => a - b)
  for (const [min, max] of intervals) {
    values.add(min - screwClearanceMm)
    values.add(max + screwClearanceMm)
  }
  for (let index = 1; index < edges.length; index++) values.add((edges[index - 1] + edges[index]) / 2)
  return [...new Set([...values].map(value => Number(value.toFixed(4))))]
    .filter(value => value >= edgeInsetMm && value <= limit)
    .sort((a, b) => a - b)
}

export function planScrewPositions(parts: Part[], sheet: Sheet, sheetIndex: number): ScrewPositionPlan {
  const errors: string[] = []
  const warnings: string[] = []
  if (sheet.screwMarkingEnabled === false) return { points: [], errors, warnings }
  const bounds: Bounds[] = []
  for (const instance of sheet.instances.filter(instance => instance.sheetIndex === sheetIndex)) {
    const part = parts.find(part => part.id === instance.partId)
    if (!part) {
      errors.push(`Cannot position screw marks for missing part ${instance.partId}.`)
      continue
    }
    const prepared = preparationBounds(part, instance, sheet.gcodeSettings.safeZ)
    errors.push(...prepared.errors)
    const placed = prepared.bounds
    if (!isFiniteBounds(placed) || placed.minX < 0 || placed.minY < 0 || placed.maxX > sheet.width || placed.maxY > sheet.height) {
      errors.push(`Cannot position screw marks around invalid or out-of-sheet part ${part.name}.`)
      continue
    }
    bounds.push(placed)
  }
  if (errors.length || !bounds.length) return { points: [], errors, warnings }

  // Exclude the entire part rectangles, including pockets and finished-part interiors.
  const maxX = Math.max(...bounds.map(bounds => bounds.maxX))
  const maxY = Math.max(...bounds.map(bounds => bounds.maxY))
  const xs = axisCandidates(maxX, bounds.map(bounds => [bounds.minX, bounds.maxX]))
  const ys = axisCandidates(maxY, bounds.map(bounds => [bounds.minY, bounds.maxY]))
  const candidates = ys.flatMap(y => xs.map(x => ({ x, y })))
    .filter(point => bounds.every(bounds => distanceToBounds(point, bounds) >= screwClearanceMm))
  const points: Point[] = []
  if (candidates.length) points.push(candidates.shift()!)
  while (candidates.length && points.length < maximumMarks) {
    let bestIndex = 0
    let bestDistance = -Infinity
    candidates.forEach((point, index) => {
      const distance = Math.min(...points.map(selected => Math.hypot(point.x - selected.x, point.y - selected.y)))
      if (distance > bestDistance) { bestDistance = distance; bestIndex = index }
    })
    if (bestDistance < targetSpacingMm && points.length >= 4) break
    if (bestDistance < screwClearanceMm * 2) break
    points.push(candidates.splice(bestIndex, 1)[0])
  }
  points.sort((a, b) => a.y - b.y || a.x - b.x)
  if (!points.length) errors.push(`No screw marks fit on sheet ${sheetIndex + 1} within the machining extent and ${screwClearanceMm} mm clearance. Increase the border or part spacing, or turn off screw marking.`)
  else if (points.length < 4) warnings.push(`Only ${points.length} screw mark${points.length === 1 ? '' : 's'} fit on sheet ${sheetIndex + 1}; check workholding before machining.`)
  return { points, errors, warnings }
}
