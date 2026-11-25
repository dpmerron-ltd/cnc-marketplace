import type { DayCut, DailyPlan } from './dailyPlan'

export const stockSquareMm = 1220

function sheetSize(cut: DayCut): { width: number; height: number } | undefined {
  if (cut.sheetWidthMm !== undefined && cut.sheetHeightMm !== undefined)
    return { width: cut.sheetWidthMm, height: cut.sheetHeightMm }
  // Plans saved before sheet dimensions were explicit already retain them in
  // the layout signature. Read that snapshot instead of assuming a stock size.
  try {
    const { settings } = JSON.parse(cut.signature)
    return { width: settings.width, height: settings.height }
  } catch {
    return undefined
  }
}

/** Count physical layouts, not components, orders or an area approximation. */
export function dailyMaterialRequirements(plan: Pick<DailyPlan, 'cuts'>) {
  const groups = new Map<string, { key: string; material: string; squares: number; reviewSheets: number }>()
  const seen = new Set<string>()
  for (const cut of plan.cuts) {
    const id = JSON.stringify([cut.jobId, cut.sheetIndex])
    if (seen.has(id)) continue
    seen.add(id)
    const key = cut.materialKey || cut.material
    const group = groups.get(key) ?? { key, material: cut.material, squares: 0, reviewSheets: 0 }
    const size = sheetSize(cut)
    if (
      size &&
      Number.isFinite(size.width) &&
      Number.isFinite(size.height) &&
      size.width > 0 &&
      size.height > 0 &&
      size.width <= stockSquareMm &&
      size.height <= stockSquareMm
    )
      group.squares++
    else group.reviewSheets++
    groups.set(key, group)
  }
  const materials = [...groups.values()].sort((a, b) =>
    a.material.localeCompare(b.material, undefined, { numeric: true })
  )
  return {
    materials,
    totalSquares: materials.reduce((n, m) => n + m.squares, 0),
    reviewSheets: materials.reduce((n, m) => n + m.reviewSheets, 0)
  }
}
