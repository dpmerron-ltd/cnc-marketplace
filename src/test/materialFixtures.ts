import { materialProfiles, materialVariantsSchema } from '../cam/materialProfiles'
import type { Part } from '../models/Part'
import type { Sheet } from '../models/Sheet'
import type { PartInstance } from '../models/PartInstance'
import type { StockMaterial } from '../models/stockMaterial'
import { testParts } from './jobFixtures'

export const natural: StockMaterial = { thicknessMm: 12, type: 'Plywood', finish: 'Natural' }
export const hex: StockMaterial = { ...natural, finish: 'Black hex' }
export function materialPart(id: string, stock = natural): Part {
  const part = testParts[0]
  const profiles = Object.fromEntries(materialProfiles.map(profile => [profile.id, {
    gcode: part.gcode.replace('Z-2 ', `Z-${profile.thickness + 0.4} `), warnings: [], errors: [],
  }]))
  return { ...part, id, name: id, defaultStockMaterial: stock, metadata: { ...part.metadata,
    materialVariants: materialVariantsSchema.parse({ version: 1, primaryProfile: '12', profiles }),
  } }
}
export function materialSheet(): Sheet {
  return { name: 'Materials', width: 400, height: 400, spacing: 10, borderSpacing: 10,
    stockMaterial: natural, materialProfile: '12', screwMarkingEnabled: false,
    gcodeSettings: { startGcode: 'G21 G17 G90', spindleStartGcode: 'S18000 M03', endGcode: 'M05\nM30', safeZ: 20 }, instances: [],
  }
}
export function addition(partId: string, id = crypto.randomUUID()): PartInstance {
  return { id, partId, x: 10, y: 10, rotation: 0, sheetIndex: 0, locked: false }
}
