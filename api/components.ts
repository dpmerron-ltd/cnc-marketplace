import { z } from 'zod'
import { createPartFromGCode } from '../src/gcode/importPart'
import { simulateGCode } from '../src/gcode/simulator'
import { transformPartProgram } from '../src/gcode/transform'
import { JobError } from '../src/jobs/generateJob'

export const componentBodyLimit = 4 * 1024 * 1024
const schema = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().min(1).max(100),
  filename: z.string().max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*\.(nc|tap|gcode|cnc)$/i),
  gcode: z.string().min(1).max(2000000),
  dxf: z.string().min(1).max(2000000).optional(),
})

export function parseComponent(value: unknown, ownerId: string, itemId: string) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new JobError('Invalid component. Supply a stable UUID id, name, sku, filename and gcode, with optional source dxf.', 400, parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`))
  const input = parsed.data
  if (new TextEncoder().encode(input.gcode).length > 2000000 || new TextEncoder().encode(input.dxf ?? '').length > 2000000 || input.gcode.split('\n').length > 10000) throw new JobError('Component limit: 2 MB NC, 10,000 NC lines and 2 MB optional DXF.', 413)
  const part = { ...createPartFromGCode(input.filename, input.gcode, input.dxf, itemId), id: input.id, ownerId, name: input.name, sku: input.sku }
  if (part.parsed.units !== 'mm' || part.parsed.distanceMode !== 'absolute') throw new JobError('Components must explicitly use metric and absolute positioning (G21/G90).', 422)
  if (![part.width, part.height, ...Object.values(part.originalBounds)].every(Number.isFinite) || Math.max(part.width, part.height) <= 0 || Math.max(part.width, part.height) > 10000) throw new JobError('Component must contain finite machining geometry within 10,000 mm.', 422)
  const transformed = transformPartProgram(part, { id: 'validation', partId: part.id, sheetIndex: 0, x: 0, y: 0, rotation: 0, locked: false })
  const simulation = simulateGCode(input.gcode)
  const errors = [...new Set([...transformed.errors, ...simulation.errors])]
  if (errors.length) throw new JobError('Component failed machining validation and was not saved.', 422, errors)
  if (simulation.deepestCutMm <= 0) throw new JobError('Component contains no below-surface cutting moves.', 422)
  return { part, warnings: [...new Set([...transformed.warnings, ...simulation.warnings])] }
}
