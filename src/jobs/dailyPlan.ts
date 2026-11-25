import { stockSquareMm } from './dailyMaterials'
import type { ReportPlanningProgress } from './planningProgress'
import type { Part } from '../models/Part'
import type { MarketplaceItem } from '../models/Item'
import type { Sheet } from '../models/Sheet'
import type { ShopifyOrder } from '../orders/types'
import { matchOrderItems, prepareOrderAdditions } from '../orders/addOrderToSheet'
import { allocateMaterials } from '../nesting/allocateMaterials'
import { requiredMaterial, sheetMaterial, stockKey, stockLabel } from '../models/stockMaterial'
import { exportPhysicalSheetGCodes } from '../gcode/exporter'
import { simulateGCode } from '../gcode/simulator'
import type { ProgramSettings } from '../gcode/programSettings'
import {
  newProductionJob,
  replanWorkspace,
  sheetIndices,
  sheetSignature,
  today,
  type SheetWorkspace
} from './production'
import { orderCuttingSheets } from '../orders/cuttingSheets'

export interface DayCut {
  jobId: string
  sheetIndex: number
  sheetWidthMm?: number
  sheetHeightMm?: number
  signature: string
  orders: string[]
  material: string
  materialKey: string
  placedAt: number
  seconds: number
  parts: number
}
export interface ScheduledCut extends DayCut {
  machine: number
  startMinute: number
  endMinute: number
}
export interface DailyPlan {
  programs?: ProgramSettings
  date: string
  createdAt: string
  cuts: ScheduledCut[]
  deferred: DayCut[]
  issues: string[]
  warnings: string[]
  orders: { name: string; scheduled: number; waiting: number; cutting: number; cut: number; pending: number }[]
}
export const dayCutBudgetSeconds = 12 * 60 * 60
export const sheetHandlingMinutes = 15

/** Reserve handling before each sheet. FIFO selects work; material batching only
 * changes its running sequence after selection, so it cannot displace old work. */
export function scheduleDay(candidates: DayCut[]) {
  const machines: ScheduledCut[][] = [[], []],
    deferred: DayCut[] = []
  let seconds = 0
  for (const cut of [...candidates].sort(
    (a, b) => a.placedAt - b.placedAt || a.jobId.localeCompare(b.jobId) || a.sheetIndex - b.sheetIndex
  )) {
    if (!Number.isFinite(cut.seconds) || cut.seconds <= 0) throw new Error('A sheet has no valid runtime estimate.')
    const duration = cut.seconds / 60 + sheetHandlingMinutes
    const fits = machines
      .map((cuts, index) => ({
        index,
        used: cuts.reduce((sum, c) => sum + c.seconds / 60 + sheetHandlingMinutes, 0),
        same: cuts.some((c) => c.materialKey === cut.materialKey)
      }))
      .filter((m) => m.used + duration <= 480 && seconds + cut.seconds <= dayCutBudgetSeconds)
      .sort((a, b) => Number(b.same) - Number(a.same) || a.used - b.used || a.index - b.index)
    if (!fits.length) {
      deferred.push(cut)
      continue
    }
    const m = fits[0]
    seconds += cut.seconds
    machines[m.index].push({ ...cut, machine: m.index + 1, startMinute: 0, endMinute: 0 })
  }
  for (const cuts of machines) {
    // Keep material groups in the order their oldest sheet was selected.
    const groups = [...new Set(cuts.map((c) => c.materialKey))]
    cuts.sort((a, b) => groups.indexOf(a.materialKey) - groups.indexOf(b.materialKey) || a.placedAt - b.placedAt)
    let minute = 9 * 60
    for (const cut of cuts) {
      cut.startMinute = minute + sheetHandlingMinutes
      cut.endMinute = cut.startMinute + cut.seconds / 60
      minute = cut.endMinute
    }
  }
  return { cuts: machines.flat(), deferred }
}

export interface DailyPlanInput {
  workspace: SheetWorkspace
  parts: Part[]
  items: MarketplaceItem[]
  baseSheet: Sheet
  orders: ShopifyOrder[]
  shop: string
  owner: string
  programs: ProgramSettings
}
export function buildDailyPlan(input: DailyPlanInput, onProgress?: ReportPlanningProgress): SheetWorkspace {
  const { workspace, parts, items, baseSheet, shop, owner, programs } = input
  if (workspace.jobs.some((j) => Object.values(j.sheets).some((s) => s.stage === 'cutting')))
    throw new Error(
      'A sheet is currently cutting. Finish or update its status before planning a fresh 09:00–17:00 day.'
    )
  const issues: string[] = [],
    warnings: string[] = []
  const orders = input.orders
    .filter((o) => !o.cancelledAt && !o.closedAt)
    .sort((a, b) => (Date.parse(a.createdAt ?? '') || Infinity) - (Date.parse(b.createdAt ?? '') || Infinity))
  let staged: Sheet = {
    ...baseSheet,
    width: stockSquareMm,
    height: stockSquareMm,
    name: `Orders planned ${today()}`,
    instances: [],
    pendingParts: [],
    sheetMaterials: undefined,
    stockMaterial: undefined,
    materialProfile: undefined,
    material: undefined,
    orderImports: [],
    orderNumber: undefined,
    unavailableSheetIndices: undefined,
    nextPartNumber: undefined
  }
  for (const [orderIndex, order] of orders.entries()) {
    onProgress?.({
      percent: 45 + (25 * orderIndex) / Math.max(orders.length, 1),
      message: `Nesting order ${orderIndex + 1} of ${orders.length}: ${order.name}`
    })
    if (!Number.isFinite(Date.parse(order.createdAt ?? ''))) {
      issues.push(`${order.name}: order placed date is missing; excluded.`)
      continue
    }
    const progress = orderCuttingSheets(workspace.jobs, { key: `${shop}/${order.id}`, name: order.name })
    if (progress.sheets.length || progress.pending.length) {
      if (progress.pending.length) issues.push(`${order.name}: existing parts await material allocation.`)
      continue
    }
    try {
      const remaining = {
        ...order,
        lineItems: {
          ...order.lineItems,
          nodes: order.lineItems.nodes.map((l) => ({
            ...l,
            currentQuantity: Math.min(l.currentQuantity, l.unfulfilledQuantity)
          }))
        }
      }
      if (!remaining.lineItems.nodes.some((l) => l.currentQuantity > 0)) continue
      const request = { shop, order: remaining, matches: matchOrderItems(remaining, items, owner) }
      const { additions, key } = prepareOrderAdditions(request, items, parts, staged, owner)
      if (additions.some((i) => !requiredMaterial(parts.find((p) => p.id === i.partId)!)))
        throw new Error('Specify material, thickness and finish on every component first.')
      if (staged.instances.length + additions.length > 2000)
        throw new Error('Planning batch exceeds 2,000 new parts; plan the remaining orders after this batch.')
      const next = allocateMaterials(parts, staged, additions)
      staged = {
        ...next,
        orderImports: [
          ...(staged.orderImports ?? []),
          { key, name: order.name, instanceIds: additions.map((i) => i.id) }
        ]
      }
    } catch (e) {
      issues.push(`${order.name}: ${(e as Error).message}`)
    }
  }
  onProgress?.({ percent: 70, message: 'Combining compatible waiting sheets…' })
  let jobs = staged.instances.length ? [...workspace.jobs, newProductionJob(staged)] : workspace.jobs
  // Fill compatible waiting sheets across existing jobs and newly loaded orders.
  // Unrelated/manual work and completed layouts are never pulled into this plan.
  const eligible = jobs.filter(
    (job) =>
      !job.archived &&
      job.sheet.instances.some((i) => (job.sheets[i.sheetIndex]?.stage ?? 'waiting') === 'waiting') &&
      job.sheet.instances
        .filter((i) => (job.sheets[i.sheetIndex]?.stage ?? 'waiting') === 'waiting')
        .every((i) => {
          const imported = job.sheet.orderImports?.find((r) => r.instanceIds.includes(i.id))
          const key = i.orderKey ?? imported?.key
          return orders.some(
            (o) =>
              Number.isFinite(Date.parse(o.createdAt ?? '')) &&
              (key ? key === `${shop}/${o.id}` : (i.orderName ?? imported?.name) === o.name)
          )
        })
  )
  if (eligible.length > 1) {
    const replanned = replanWorkspace({ activeId: eligible[0].id, jobs: eligible }, parts)
    jobs = jobs.map((job) => replanned.jobs.find((j) => j.id === job.id) ?? job)
  }
  onProgress?.({ percent: 78, message: 'Estimating sheet cutting times…' })
  const sheetTotal = jobs
    .filter((job) => !job.archived)
    .reduce(
      (n, job) =>
        n + sheetIndices(job.sheet).filter((index) => (job.sheets[index]?.stage ?? 'waiting') === 'waiting').length,
      0
    )
  let checkedSheets = 0
  const candidates: DayCut[] = []
  for (const job of jobs) {
    if (job.archived) continue
    for (const index of sheetIndices(job.sheet)) {
      if ((job.sheets[index]?.stage ?? 'waiting') !== 'waiting') continue
      onProgress?.({
        percent: 78 + (18 * checkedSheets++) / Math.max(sheetTotal, 1),
        message: `Checking cutting time for sheet ${checkedSheets} of ${sheetTotal}`
      })
      const instances = job.sheet.instances.filter((i) => i.sheetIndex === index)
      const matched = orders.filter((o) =>
        orderCuttingSheets([job], { key: `${shop}/${o.id}`, name: o.name }).sheets.some((s) => s.index === index)
      )
      const knownIds = new Set(
        matched.flatMap((o) => {
          const key = `${shop}/${o.id}`
          return instances
            .filter(
              (i) =>
                i.orderKey === key ||
                (!i.orderKey &&
                  (i.orderName === o.name ||
                    job.sheet.orderImports?.some((r) => r.key === key && r.instanceIds.includes(i.id))))
            )
            .map((i) => i.id)
        })
      )
      if (!matched.length) continue
      if (knownIds.size !== instances.length || matched.some((o) => !Number.isFinite(Date.parse(o.createdAt ?? '')))) {
        issues.push(`${job.name}, sheet ${index + 1}: includes work outside dated open orders; excluded.`)
        continue
      }
      try {
        const stock = sheetMaterial(job.sheet, index).stockMaterial
        if (!stock) throw new Error('Material, thickness and finish are required.')
        const [file] = exportPhysicalSheetGCodes(parts, { ...job.sheet, instances }, programs)
        if (file.errors.length) throw new Error(file.errors.join(' '))
        const sim = simulateGCode(file.gcode)
        if (sim.errors.length) throw new Error(sim.errors.join(' '))
        if (!Number.isFinite(sim.estimatedSeconds) || sim.estimatedSeconds <= 0)
          throw new Error('No valid cutting time estimate.')
        warnings.push(...file.warnings, ...sim.warnings)
        candidates.push({
          jobId: job.id,
          sheetIndex: index,
          sheetWidthMm: job.sheet.width,
          sheetHeightMm: job.sheet.height,
          signature: sheetSignature(job.sheet, index),
          orders: matched.map((o) => o.name),
          material: stockLabel(stock),
          materialKey: stockKey(stock),
          placedAt: Math.min(...matched.map((o) => Date.parse(o.createdAt!))),
          seconds: sim.estimatedSeconds,
          parts: instances.length
        })
      } catch (e) {
        issues.push(`${job.name}, sheet ${index + 1}: ${(e as Error).message}`)
      }
    }
  }
  onProgress?.({ percent: 97, message: 'Assigning sheets to both machines…' })
  const scheduled = scheduleDay(candidates)
  const progress = orders.map((o) => {
    const p = orderCuttingSheets(jobs, { key: `${shop}/${o.id}`, name: o.name })
    return {
      name: o.name,
      pending: p.pending.reduce((n, p) => n + p.count, 0),
      ...p.sheets.reduce(
        (counts, s) => {
          const key =
            s.stage === 'waiting' && scheduled.cuts.some((c) => c.jobId === s.job.id && c.sheetIndex === s.index)
              ? 'scheduled'
              : s.stage
          counts[key] += s.partCount
          return counts
        },
        { scheduled: 0, waiting: 0, cutting: 0, cut: 0 }
      )
    }
  })
  const activeId = jobs.find((j) => j.id === workspace.activeId && !j.archived)?.id ?? jobs.find((j) => !j.archived)!.id
  return {
    ...workspace,
    activeId,
    jobs,
    dailyPlan: {
      programs,
      date: today(),
      createdAt: new Date().toISOString(),
      ...scheduled,
      issues,
      warnings: [...new Set(warnings)],
      orders: progress
    }
  }
}
export function dailyPlanIsCurrent(workspace: SheetWorkspace, programs?: ProgramSettings): boolean {
  return Boolean(
    workspace.dailyPlan &&
    workspace.dailyPlan.date === today() &&
    (!programs || JSON.stringify(workspace.dailyPlan.programs) === JSON.stringify(programs)) &&
    workspace.dailyPlan.cuts.every((c) => {
      const job = workspace.jobs.find((j) => j.id === c.jobId && !j.archived)
      return job && sheetSignature(job.sheet, c.sheetIndex) === c.signature
    })
  )
}
