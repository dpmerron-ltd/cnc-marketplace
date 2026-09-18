import { describe, expect, it } from 'vitest'
import { imageBytes, itemImageMaxBytes, itemImageSchema, itemImageUrl } from './ItemImage'
import { testImage } from '../test/imageFixture'

describe('item image validation', () => {
  it('accepts bounded raster images and generates a typed data URL', () => {
    expect(itemImageSchema.parse(testImage)).toEqual(testImage)
    expect(imageBytes(testImage)[0]).toBe(137)
    expect(itemImageUrl(testImage)).toBe(`data:image/png;base64,${testImage.dataBase64}`)
  })
  it('rejects active content, MIME spoofing, malformed base64, extra fields and excessive sizes', () => {
    for (const image of [
      { ...testImage, contentType: 'image/svg+xml' },
      { ...testImage, contentType: 'image/jpeg' },
      { ...testImage, dataBase64: 'data:image/png;base64,' + testImage.dataBase64 },
      { ...testImage, dataBase64: btoa('<svg/>') },
      { ...testImage, dataBase64: 'a'.repeat(4 * Math.ceil(itemImageMaxBytes / 3) + 4) },
      { ...testImage, ownerId: 'other' },
    ]) expect(itemImageSchema.safeParse(image).success).toBe(false)
  })
  it('rejects excessive or empty image dimensions', () => {
    for (const width of [0, 4097]) {
      const bytes = imageBytes(testImage)
      new DataView(bytes.buffer).setUint32(16, width)
      expect(itemImageSchema.safeParse({ ...testImage, dataBase64: btoa(String.fromCharCode(...bytes)) }).success).toBe(false)
    }
  })
})
