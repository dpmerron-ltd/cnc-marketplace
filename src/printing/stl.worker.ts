import { parseStl } from './stl'

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const mesh = parseStl(event.data)
    self.postMessage({ mesh }, { transfer: [mesh.positions.buffer, mesh.normals.buffer] })
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'STL could not be read.' }) }
}
