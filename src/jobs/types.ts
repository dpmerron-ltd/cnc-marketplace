import type { PartLabel } from '../labels/partLabels'
import type { Bounds } from '../models/geometry'
import type { ProgramSettings } from '../gcode/programSettings'

export type JobStatus = 'awaiting_review' | 'ready' | 'cutting' | 'completed' | 'cancelled'
export interface JobRequest {
  jobName: string
  orderNumber: string
  notes: string
  items: Array<{ itemId?: string; sku?: string; quantity: number }>
  sheet: { widthMm: number; heightMm: number; material: string; thicknessMm?: number; spacingMm: number; borderMm: number; safeZMm: number; screwMarks: boolean }
  labels: { widthMm: number; heightMm: number }
}
export interface JobCut extends PartLabel {
  partId: string
  widthMm: number
  heightMm: number
  bounds: Bounds
  deepestCutMm: number
  sourceFilename: string
}
export interface JobManifest {
  version: 1
  programSettings?: ProgramSettings
  request: JobRequest
  items: Array<{ id: string; sku: string; name: string; quantity: number; componentsPerItem: number }>
  cuts: JobCut[]
  sheets: Array<{ number: number; partCount: number; maxX: number; maxY: number; deepestCutMm: number; estimatedSeconds: number; screwMarks: number }>
  warnings: string[]
  setup: string[]
  sources: Array<{ id: string; filename: string; sha256: string; feeds: number[]; spindleSpeeds: number[] }>
}
export interface JobFile { name: string; contentType: string; bytes: number; sha256: string }
export interface CuttingJob {
  id: string
  job_name: string
  order_number: string
  status: JobStatus
  created_at: string
  updated_at: string
  manifest: JobManifest
  files: JobFile[]
  status_history: Array<{ status: JobStatus; at: string; actor: string }>
}
export interface JobSummary extends Omit<CuttingJob, 'manifest'> { part_count: number; sheet_count: number }
