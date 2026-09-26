import { z } from 'zod'

export const maxStlBytes = 25 * 1024 * 1024
export const maxStlTriangles = 500000
export const printableDetailsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  purpose: z.enum(['product', 'packaging']),
  item_id: z.uuid().nullable(),
  notes: z.string().trim().max(4000),
  units: z.enum(['mm', 'inches']),
})
export type PrintableDetails = z.infer<typeof printableDetailsSchema>
export interface StlInfo { dimensions: [number, number, number]; triangles: number }
export interface ParsedStl extends StlInfo { positions: Float32Array; normals: Float32Array }
export interface PrintableAsset extends PrintableDetails {
  id: string
  owner_id: string
  filename: string
  file_bytes: number
  triangles: number
  dimensions: [number, number, number]
  created_at: string
  stl_path: string
  preview_path: string
}
export const purposeLabel = (purpose: PrintableDetails['purpose']) => purpose === 'product' ? 'Product part' : 'Packaging'
export const dimensionLabel = (dimensions: number[], units: PrintableDetails['units']) => `${dimensions.map(n => Number(n.toFixed(2))).join(' × ')} ${units === 'mm' ? 'mm' : 'in'}`
export const fileSizeLabel = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`
