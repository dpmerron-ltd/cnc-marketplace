import { readDxf } from './dxf'
import { generateCam } from './generate'
import type { CamSettings } from './types'
import { generateMaterialVariants } from './materialVariants'

self.onmessage = (event: MessageEvent<{ source: string; settings: CamSettings }>) => {
  try {
    const drawing = readDxf(event.data.source, event.data.settings.units)
    const result = generateCam(drawing, event.data.settings)
    const materialVariants = generateMaterialVariants(drawing, event.data.settings, result)
    const primary = materialVariants.profiles[materialVariants.primaryProfile]
    if (!primary) throw new Error('Primary material profile is missing.')
    if (primary.errors.length) { result.errors = primary.errors; result.gcode = '' }
    self.postMessage({ result, materialVariants })
  }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'DXF generation failed.' }) }
}
