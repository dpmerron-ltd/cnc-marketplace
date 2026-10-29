import type { SheetWorkspace } from '../jobs/production'

const versions = new Map<string, number>()
export function workspaceVersion(owner: string): number { return versions.get(owner) ?? 0 }
export function setWorkspaceVersion(owner: string, version: number) { versions.set(owner, version) }
export function cacheWorkspace(owner: string, workspace: SheetWorkspace): boolean {
  try { localStorage.setItem(`cnc-cutting-workspace:${owner}`, JSON.stringify({ workspace, baseVersion: workspaceVersion(owner) })); return true } catch { return false }
}
export function cachedWorkspace(owner: string): { workspace: SheetWorkspace; baseVersion: number } | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(`cnc-cutting-workspace:${owner}`) ?? 'null')
    const workspace = value?.workspace
    return workspace && Array.isArray(workspace.jobs) && workspace.jobs.length && workspace.jobs.some((job: { id: string }) => job.id === workspace.activeId) ? value : undefined
  } catch { return undefined }
}
export function preserveWorkspaceRecovery(owner: string) {
  const saved = localStorage.getItem(`cnc-cutting-workspace:${owner}`)
  if (saved) try { localStorage.setItem(`cnc-cutting-recovery:${owner}`, saved) } catch { /* The existing cache remains available. */ }
}
export function recoveryWorkspace(owner: string): SheetWorkspace | undefined {
  try { return JSON.parse(localStorage.getItem(`cnc-cutting-recovery:${owner}`) ?? 'null')?.workspace } catch { return undefined }
}
