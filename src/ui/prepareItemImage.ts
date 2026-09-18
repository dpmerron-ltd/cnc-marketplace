import { itemImageMaxBytes, itemImageSchema, type ItemImage } from '../models/ItemImage'

export async function prepareItemImage(file: File): Promise<ItemImage> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG or WebP image.')
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('Choose an image under 20 MB.')
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('This image could not be opened. Choose another image.') })
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40000000) throw new Error('Choose an image under 40 megapixels.')
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image processing is unavailable in this browser.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    for (const quality of [0.88, 0.75, 0.6, 0.4]) {
      const dataBase64 = canvas.toDataURL('image/jpeg', quality).split(',')[1]
      if (dataBase64 && dataBase64.length <= 4 * Math.ceil(itemImageMaxBytes / 3)) {
        return itemImageSchema.parse({ contentType: 'image/jpeg', dataBase64 })
      }
    }
    throw new Error('Image is too detailed. Choose a smaller image.')
  } finally { bitmap.close() }
}
