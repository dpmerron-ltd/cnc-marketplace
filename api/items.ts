import { z } from 'zod'
import { itemImageSchema } from '../src/models/ItemImage'

export const createItemSchema = z.strictObject({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().min(1).max(100),
  description: z.string().max(10000).default(''),
  image: itemImageSchema.nullable().optional(),
})
export type CreateItemInput = z.infer<typeof createItemSchema>
export const updateImageSchema = z.strictObject({ image: itemImageSchema.nullable() })
