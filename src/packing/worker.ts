import { estimateStockPacking } from './stockPacking'
import type { BoxStock } from './boxStock'
import type { PackingPiece, PackingSettings } from './types'
self.onmessage = (event: MessageEvent<Array<{ id: string; pieces: PackingPiece[]; settings?: PackingSettings; boxes?: BoxStock[] }>>) => {
  for (const item of event.data) {
    try { self.postMessage({ id: item.id, result: estimateStockPacking(item.pieces, item.settings, item.boxes) }) }
    catch { self.postMessage({ id: item.id, error: 'Packing calculation failed. Check component dimensions.' }) }
  }
}
