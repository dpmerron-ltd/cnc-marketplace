import { z } from 'zod'

export const itemImageMaxBytes = 512 * 1024
export const itemImageBodyLimit = 720 * 1024
export interface ItemImage { contentType: 'image/jpeg' | 'image/png'; dataBase64: string }

export function imageBytes(image: ItemImage): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(image.dataBase64), char => char.charCodeAt(0))
}

function dimensions(bytes: Uint8Array, contentType: ItemImage['contentType']): [number, number] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (contentType === 'image/png') {
    if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte) || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return
    return [view.getUint32(16), view.getUint32(20)]
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return
  let at = 2
  while (at + 3 < bytes.length) {
    if (bytes[at++] !== 0xff) return
    while (bytes[at] === 0xff) at++
    const marker = bytes[at++]
    if (marker === 0xda || marker === 0xd9 || at + 2 > bytes.length) return
    const length = view.getUint16(at)
    if (length < 2 || at + length > bytes.length) return
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) return [view.getUint16(at + 5), view.getUint16(at + 3)]
    at += length
  }
}

export const itemImageSchema = z.strictObject({
  contentType: z.enum(['image/jpeg', 'image/png']),
  dataBase64: z.string().min(4).max(4 * Math.ceil(itemImageMaxBytes / 3)).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).superRefine((image, ctx) => {
  try {
    const bytes = imageBytes(image)
    const size = dimensions(bytes, image.contentType)
    if (bytes.length > itemImageMaxBytes || !size || size.some(n => n < 1 || n > 4096) || size[0] * size[1] > 16000000) {
      ctx.addIssue({ code: 'custom', message: 'Use a JPEG or PNG image up to 512 KiB and 4096 pixels per side (16 megapixels maximum).' })
    }
  } catch { ctx.addIssue({ code: 'custom', message: 'Invalid image data.' }) }
})

export function itemImageUrl(image: ItemImage): string {
  return `data:${image.contentType};base64,${image.dataBase64}`
}
