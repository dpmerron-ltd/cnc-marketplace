import type { Sheet } from '../models/Sheet'
import type { Part } from '../models/Part'
import { autoNest } from '../nesting/nestingEngine'
import { numberSheetParts } from '../labels/partLabels'

export type SheetStage = 'waiting' | 'cutting' | 'cut'
export interface ProductionSheet {
  stage: SheetStage
  runId?: string
  combined?: boolean
  signature?: string
}
export interface ProductionJob {
  id: string
  name: string
  revision: number
  archived?: boolean
  sheet: Sheet
  sheets: Record<number, ProductionSheet>
}
export interface SheetWorkspace { updatedAt?: string; activeId: string; jobs: ProductionJob[] }
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
export function newProductionJob(sheet: Sheet): ProductionJob {
  return { id: crypto.randomUUID(), name: today(), revision: 0, sheet: { ...sheet }, sheets: {} }
}
export function newWorkspace(sheet: Sheet): SheetWorkspace {
  const job = newProductionJob(sheet)
  return { activeId: job.id, jobs: [job] }
}
export function sheetIndices(sheet: Sheet): number[] {
  return [...new Set(sheet.instances.map(i => i.sheetIndex))].sort((a, b) => a - b)
}
export function waitingSheetIndices(job: ProductionJob): number[] {
  return sheetIndices(job.sheet).filter(index => (job.sheets[index]?.stage ?? 'waiting') === 'waiting')
}
export function sheetSignature(sheet: Sheet, index: number): string {
  // Catalogue component IDs identify immutable revisions. Ignore names and other sheets.
  const { instances, name: _name, orderImports: _imports, orderNumber: _order, nextPartNumber: _next, unavailableSheetIndices: _blocked, ...settings } = sheet
  return JSON.stringify({ settings, instances: instances.filter(i => i.sheetIndex === index).map(({ locked: _locked, orderName: _orderName, ...i }) => i) })
}
export function sheetNeedsExport(job: ProductionJob, index: number): boolean {
  const state = job.sheets[index]
  const sharedFileStarted = state?.stage === 'waiting' && state.combined && Object.values(job.sheets).some(other => other.runId === state.runId && other.stage !== 'waiting')
  return !state?.runId || state.signature !== sheetSignature(job.sheet, index) || Boolean(sharedFileStarted)
}
export function updateProductionSheet(job: ProductionJob, sheet: Sheet): ProductionJob {
  for (const index of sheetIndices(job.sheet)) {
    if (job.sheets[index]?.stage !== undefined && job.sheets[index].stage !== 'waiting' && sheetSignature(job.sheet, index) !== sheetSignature(sheet, index)) {
      throw new Error(`Sheet ${index + 1} is already cutting or cut. Its layout and material settings are fixed.`)
    }
  }
  return { ...job, sheet: { ...sheet, unavailableSheetIndices: undefined } }
}
export function changeSheetStage(job: ProductionJob, index: number, stage: SheetStage): ProductionJob {
  const current = job.sheets[index]?.stage ?? 'waiting'
  if (!sheetIndices(job.sheet).includes(index)) throw new Error('This physical sheet no longer exists.')
  if (current === 'cut' || stage === 'waiting' || (current === 'cutting' && stage !== 'cut')) throw new Error('Cut sheets cannot return to planning. Request a re-cut for replacement parts.')
  if (sheetNeedsExport(job, index)) throw new Error('Export the latest layout before marking this sheet as cutting or cut.')
  return { ...job, sheets: { ...job.sheets, [index]: { ...job.sheets[index], stage } } }
}
export function planWaitingSheets(job: ProductionJob, parts: Part[]): ProductionJob {
  const closed = new Set(sheetIndices(job.sheet).filter(i => job.sheets[i]?.stage && job.sheets[i].stage !== 'waiting'))
  const waiting = job.sheet.instances.filter(i => !closed.has(i.sheetIndex))
  if (!waiting.length) return job
  const openIndices: number[] = []
  for (let i = 0; openIndices.length < waiting.length; i++) if (!closed.has(i)) openIndices.push(i)
  const nested = autoNest(parts, { ...job.sheet, instances: waiting.map(i => ({ ...i, locked: false, sheetIndex: 0 })) })
  const sheet = numberSheetParts({ ...job.sheet, instances: [
    ...job.sheet.instances.filter(i => closed.has(i.sheetIndex)),
    ...nested.map(i => ({ ...i, sheetIndex: openIndices[i.sheetIndex] })),
  ] })
  return updateProductionSheet(job, sheet)
}
export function waitingExportSheet(job: ProductionJob): Sheet {
  const indices = new Set(waitingSheetIndices(job))
  return { ...job.sheet, instances: job.sheet.instances.filter(i => indices.has(i.sheetIndex)) }
}

export function removeProductionJob(workspace: SheetWorkspace, id: string): SheetWorkspace {
  const job = workspace.jobs.find(job => job.id === id)
  if (!job || job.archived) return workspace
  if (Object.values(job.sheets).some(sheet => sheet.stage === 'cutting')) {
    throw new Error('Mark sheets that are still cutting as cut before removing this job.')
  }
  // Keep exported jobs as a record so removed waiting files remain superseded.
  const keepRecord = job.revision > 0 || Object.values(job.sheets).some(sheet => sheet.runId || sheet.stage === 'cut')
  const retained = job.sheet.instances.filter(instance => job.sheets[instance.sheetIndex]?.stage === 'cut')
  const jobs = keepRecord
    ? workspace.jobs.map(candidate => candidate.id === id ? { ...job, archived: true, sheet: { ...job.sheet, instances: retained } } : candidate)
    : workspace.jobs.filter(candidate => candidate.id !== id)
  let active = jobs.find(candidate => candidate.id === workspace.activeId && !candidate.archived)
    ?? jobs.find(candidate => !candidate.archived && (!candidate.sheet.instances.length || waitingSheetIndices(candidate).length))
  if (!active) {
    active = newProductionJob({ ...job.sheet, name: today(), instances: [], orderNumber: undefined, orderImports: undefined, nextPartNumber: undefined })
    jobs.push(active)
  }
  return { ...workspace, activeId: active.id, jobs }
}

export function replanWorkspace(workspace: SheetWorkspace, parts: Part[]): SheetWorkspace {
  const groups = new Map<string, ProductionJob[]>()
  for (const job of workspace.jobs) {
    if (job.archived || !waitingSheetIndices(job).length) continue
    const sheet = job.sheet
    const key = JSON.stringify([sheet.materialProfile, sheet.material?.trim().toLowerCase(), sheet.width, sheet.height, sheet.spacing, sheet.borderSpacing, sheet.safeZOverrideMm, sheet.screwMarkingEnabled, sheet.gcodeSettings])
    groups.set(key, [...(groups.get(key) ?? []), job])
  }
  const replacements = new Map<string, ProductionJob>()
  for (const group of groups.values()) {
    const target = group[0]
    const additions = group.flatMap(job => job.sheet.instances.filter(i => (job.sheets[i.sheetIndex]?.stage ?? 'waiting') === 'waiting').map(i => ({
      ...i, partNumber: job.id === target.id ? i.partNumber : undefined,
      orderName: i.orderName || job.sheet.orderImports?.find(order => order.instanceIds.includes(i.id))?.name || job.sheet.orderNumber,
    })))
    const retained = target.sheet.instances.filter(i => target.sheets[i.sheetIndex]?.stage && target.sheets[i.sheetIndex].stage !== 'waiting')
    const firstOpen = Array.from({ length: retained.length + 1 }, (_, i) => i).find(i => !target.sheets[i]?.stage || target.sheets[i].stage === 'waiting')!
    const merged = { ...target, sheet: numberSheetParts({ ...target.sheet, instances: [...retained, ...additions.map(i => ({ ...i, sheetIndex: firstOpen }))] }) }
    replacements.set(target.id, planWaitingSheets(merged, parts))
    for (const job of group.slice(1)) replacements.set(job.id, { ...job, archived: !job.sheet.instances.some(i => job.sheets[i.sheetIndex]?.stage && job.sheets[i.sheetIndex].stage !== 'waiting'), sheet: { ...job.sheet, instances: job.sheet.instances.filter(i => job.sheets[i.sheetIndex]?.stage && job.sheets[i.sheetIndex].stage !== 'waiting') } })
  }
  const jobs = workspace.jobs.map(job => replacements.get(job.id) ?? job)
  const activeId = jobs.find(job => job.id === workspace.activeId && !job.archived)?.id ?? jobs.find(job => !job.archived)!.id
  return { ...workspace, activeId, jobs }
}
