import { sheetIndices, type ProductionJob } from '../jobs/production'
import type { PartInstance } from '../models/PartInstance'

export interface CuttingOrder { key: string; name: string }

/** Follow order identities on the parts, including after jobs are re-planned. */
export function orderCuttingSheets(jobs: ProductionJob[], order: CuttingOrder) {
  function matches(job: ProductionJob, instance: PartInstance) {
    const imported = job.sheet.orderImports?.find(entry => entry.instanceIds.includes(instance.id))
    const key = instance.orderKey ?? imported?.key
    // Older saved plans only have an order name. Never override an explicit key
    // with a name match: different stores can use the same order number.
    return key ? key === order.key : (instance.orderName ?? imported?.name)?.trim() === order.name.trim()
  }
  const sheets = jobs.flatMap(job => sheetIndices(job.sheet).flatMap(index => {
    const stage = job.sheets[index]?.stage ?? 'waiting'
    if (job.archived && stage !== 'cut') return []
    const instances = job.sheet.instances.filter(instance => instance.sheetIndex === index)
    const parts = instances.filter(instance => matches(job, instance))
    return parts.length ? [{ job, index, stage, partCount: parts.length, totalParts: instances.length }] : []
  }))
  const rank = { waiting: 0, cutting: 1, cut: 2 }
  sheets.sort((a, b) => rank[a.stage] - rank[b.stage] || a.job.name.localeCompare(b.job.name, undefined, { numeric: true }) || a.index - b.index)
  const pending = jobs.filter(job => !job.archived).flatMap(job => {
    const count = job.sheet.pendingParts?.filter(instance => matches(job, instance)).length ?? 0
    return count ? [{ job, count }] : []
  })
  return { sheets, pending }
}
