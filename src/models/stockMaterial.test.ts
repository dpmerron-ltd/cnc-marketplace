import { expect, it } from 'vitest'
import { canonicalStockFinish, stockKey, stockLabel, stockMaterialSchema, materialSetupKey } from './stockMaterial'

it.each(['Black Hex', 'Black hex phenolic', ' BLACK   HEX ', 'black-hex phenolic'])('canonicalises %s', finish => {
  const material = { thicknessMm: 12, type: 'Plywood', finish }
  const canonical = { ...material, finish: 'Black Hex' }
  expect(stockMaterialSchema.parse(material)).toEqual(canonical)
  expect(stockKey(material)).toBe(stockKey(canonical))
  expect(stockLabel(material)).toBe('12 mm Plywood · Black Hex')
})

it('keeps other finishes, thicknesses and cutting presets distinct', () => {
  const stockMaterial = { thicknessMm: 12, type: 'Plywood', finish: 'Black Hex' }
  expect(canonicalStockFinish('Natural')).toBe('Natural')
  expect(canonicalStockFinish('Brown hex phenolic')).toBe('Brown hex phenolic')
  expect(stockKey({ ...stockMaterial, finish: 'Natural' })).not.toBe(stockKey(stockMaterial))
  expect(stockKey({ ...stockMaterial, thicknessMm: 18 })).not.toBe(stockKey(stockMaterial))
  expect(materialSetupKey({ stockMaterial, materialProfile: '12' })).not.toBe(materialSetupKey({ stockMaterial, materialProfile: '12-ramp20-5deg' }))
})
