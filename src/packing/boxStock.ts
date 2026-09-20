import { z } from 'zod'

export const boxInputSchema = z.strictObject({
  id: z.uuid(), name: z.string().trim().min(1).max(100),
  length_mm: z.number().int().min(10).max(1200), width_mm: z.number().int().min(10).max(1200), height_mm: z.number().int().min(10).max(1200),
  quantity: z.number().int().min(0).max(100000), details: z.string().max(500).default(''),
})
export const boxCountSchema = z.strictObject({ quantity: z.number().int().min(0).max(100000), expectedVersion: z.number().int().min(1) })
export const boxStockSchema = boxInputSchema.extend({ version: z.number().int().min(1), updated_at: z.string() })
export type BoxStock = z.infer<typeof boxStockSchema>
export type BoxInput = z.infer<typeof boxInputSchema>
export type BoxCount = z.infer<typeof boxCountSchema>
