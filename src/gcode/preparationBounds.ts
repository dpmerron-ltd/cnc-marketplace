import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import { includePoint } from '../models/geometry'
import { createInitialState, getWord, updatePositionFromLine } from './state'
import { instanceBounds, transformPartProgram } from './transform'
import { arcBounds } from './bounds'

export function preparationBounds(part: Part, instance: PartInstance, safeZ = 5) {
  let bounds = instanceBounds(part, instance)
  const transformed = transformPartProgram(part, instance)
  const errors = [...transformed.errors]
  let state = createInitialState()
  const firstPoint = transformed.segments[0]?.start
  if (firstPoint) state.position = { ...firstPoint, z: safeZ }
  const finalCut = transformed.transformedLines.findLastIndex(line => line.effectiveMotion === 'G01' || line.effectiveMotion === 'G02' || line.effectiveMotion === 'G03')
  for (const line of transformed.transformedLines.slice(0, finalCut + 1)) {
    const next = updatePositionFromLine(state, line)
    const motion = line.effectiveMotion
    if (motion === 'G02' || motion === 'G03') {
      const hasXy = getWord(line, 'X') !== undefined || getWord(line, 'Y') !== undefined
      if (!hasXy || getWord(line, 'R') !== undefined) {
        errors.push(`${part.name} needs explicit X/Y and I/J arc geometry for automatic sheet preparation.`)
      } else {
        const center = { x: state.position.x + (getWord(line, 'I') ?? 0), y: state.position.y + (getWord(line, 'J') ?? 0) }
        const arc = arcBounds(state.position, next.position, center, motion === 'G02')
        bounds = includePoint(bounds, { x: arc.minX, y: arc.minY })
        bounds = includePoint(bounds, { x: arc.maxX, y: arc.maxY })
      }
    }
    if (motion === 'G01' || motion === 'G02' || motion === 'G03') {
      bounds = includePoint(bounds, { x: next.position.x, y: next.position.y })
    }
    if (motion === 'G00' && Math.min(state.position.z, next.position.z) <= 0 &&
        (getWord(line, 'X') !== undefined || getWord(line, 'Y') !== undefined)) {
      bounds = includePoint(bounds, state.position)
      bounds = includePoint(bounds, next.position)
    }
    state = next
  }
  if (part.parsed.units !== 'mm' || part.parsed.distanceMode !== 'absolute') {
    errors.push(`${part.name} requires G21 millimetres and G90 absolute positioning for automatic sheet preparation.`)
  }
  return { bounds, errors }
}
