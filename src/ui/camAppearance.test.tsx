import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CamOperationSwatch } from './CamOperationSwatch'
import { operationColors, operationDashes, tabOutlineColor } from './camAppearance'

afterEach(cleanup)
function luminance(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}
describe('DXF appearance', () => {
  it('uses contrasting strokes without red or green operation colours', () => {
    for (const color of [...Object.values(operationColors), tabOutlineColor]) {
      expect((luminance('#f7fafb') + 0.05) / (luminance(color) + 0.05)).toBeGreaterThanOrEqual(3)
      expect(['#168047', '#c14424', '#c33b42']).not.toContain(color)
    }
  })
  it('pairs contour types with different line patterns and drills with a target symbol', () => {
    expect(operationDashes.outside).toEqual([])
    expect(operationDashes.inside).toEqual([8, 5])
    expect(operationDashes.pocket).toEqual([1, 4])
    const { container } = render(<><CamOperationSwatch kind="outside" /><CamOperationSwatch kind="inside" /><CamOperationSwatch kind="pocket" /><CamOperationSwatch kind="drill" /></>)
    const swatches = container.querySelectorAll('.cam-operation-swatch')
    expect(swatches[0].querySelector('i')).toHaveStyle({ borderTopStyle: 'solid' })
    expect(swatches[1].querySelector('i')).toHaveStyle({ borderTopStyle: 'dashed' })
    expect(swatches[2].querySelector('i')).toHaveStyle({ borderTopStyle: 'dotted' })
    expect(swatches[3].querySelector('svg')).not.toBeNull()
    for (const swatch of swatches) expect(swatch).toHaveAttribute('aria-hidden', 'true')
  })
})
