import { estimatePacking } from './packing'
import type { PackingPiece, PackingSettings } from './types'
self.onmessage = (event: MessageEvent<Array<{ id: string; pieces: PackingPiece[]; settings?: PackingSettings }>>) => {
  for (const item of event.data) {
    try { self.postMessage({ id: item.id, result: estimatePacking(item.pieces, item.settings) }) }
    catch { self.postMessage({ id: item.id, error: 'Packing calculation failed. Check component dimensions.' }) }
  }
}
