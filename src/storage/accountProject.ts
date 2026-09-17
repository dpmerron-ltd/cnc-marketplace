import type { Project } from '../models/Project'
import type { Sheet } from '../models/Sheet'

export function privateProject(project: Project, userId: string): Project {
  const items = (project.items ?? []).filter((item) => item.ownerId === userId)
  const itemIds = new Set(items.map((item) => item.id))
  const parts = project.parts.filter((part) => part.ownerId === userId && itemIds.has(part.itemId ?? ''))
  const partIds = new Set(parts.map((part) => part.id))
  const cleanSheet = (sheet: Sheet): Sheet => ({
    ...sheet,
    instances: sheet.instances.filter((instance) => partIds.has(instance.partId)),
    gcodePresets: sheet.gcodePresets?.filter((preset) => !preset.ownerId || preset.ownerId === userId),
  })
  return {
    ...project,
    items,
    parts,
    sheet: cleanSheet(project.sheet),
    sheetHistory: project.sheetHistory?.map((entry) => ({
      ...entry,
      sheet: cleanSheet(entry.sheet),
      selectedItemId: itemIds.has(entry.selectedItemId ?? '') ? entry.selectedItemId : undefined,
    })),
  }
}

// Explicit file imports create independent copies, never overwrite another owner's IDs.
export function copyProjectToAccount(project: Project, userId: string): Project {
  const itemIds = new Map((project.items ?? []).map((item) => [item.id, crypto.randomUUID()]))
  const partIds = new Map(project.parts.map((part) => [part.id, crypto.randomUUID()]))
  const copySheet = (sheet: Sheet): Sheet => ({
    ...sheet,
    instances: sheet.instances.filter((instance) => partIds.has(instance.partId)).map((instance) => ({
      ...instance, id: crypto.randomUUID(), partId: partIds.get(instance.partId)!,
    })),
    gcodePresets: sheet.gcodePresets?.map((preset) => ({ ...preset, id: crypto.randomUUID(), ownerId: userId, uploadedBy: undefined })),
  })
  return {
    ...project,
    items: project.items?.map((item) => ({ ...item, id: itemIds.get(item.id)!, ownerId: userId, uploadedBy: undefined,
      packing: item.packing ? { ...item.packing, components: Object.fromEntries(Object.entries(item.packing.components ?? {}).filter(([id]) => partIds.has(id)).map(([id, value]) => [partIds.get(id)!, value])) } : undefined,
    })),
    parts: project.parts.map((part) => ({ ...part, id: partIds.get(part.id)!, itemId: itemIds.get(part.itemId ?? ''), ownerId: userId })),
    sheet: copySheet(project.sheet),
    sheetHistory: project.sheetHistory?.map((entry) => ({
      ...entry, id: crypto.randomUUID(), sheet: copySheet(entry.sheet), selectedItemId: itemIds.get(entry.selectedItemId ?? ''),
    })),
  }
}
