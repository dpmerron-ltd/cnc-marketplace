import { readDxf } from './dxf'
import { generateCam } from './generate'
import type { CamSettings } from './types'

self.onmessage = (event: MessageEvent<{ source: string; settings: CamSettings }>) => {
  try { self.postMessage({ result: generateCam(readDxf(event.data.source), event.data.settings) }) }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'DXF generation failed.' }) }
}
