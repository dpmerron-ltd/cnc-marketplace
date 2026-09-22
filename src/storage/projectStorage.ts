import type { Project } from '../models/Project'
import { privateProject } from './accountProject'

const storageKey = 'sheet-builder-project'

export function saveProject(project: Project, userId: string | undefined): boolean {
  if (!userId) return false
  // A partially loaded catalogue must never replace a complete local backup.
  const loadedIds = new Set(project.parts.map(part => part.id))
  if (project.componentIndex?.some(component => !loadedIds.has(component.id))) return false
  // Avoid serializing tens of megabytes of parsed programs into synchronous browser storage.
  // The cloud retains the complete library; leave the last usable local backup intact.
  const sourceCharacters = project.parts.reduce((total, part) => total + part.gcode.length + (part.dxf?.length ?? 0) + Object.values(part.metadata.materialVariants?.profiles ?? {}).reduce((size, profile) => size + (profile?.gcode.length ?? 0), 0), 0)
    + (project.items ?? []).reduce((total, item) => total + (item.image?.dataBase64.length ?? 0), 0)
  if (sourceCharacters > 2_000_000) return false
  try {
    localStorage.setItem(`${storageKey}:${userId}`, JSON.stringify(privateProject(project, userId)))
    return true
  } catch (error) {
    console.error('Failed to save project to local storage.', error)
    return false
  }
}

export function loadProject(userId: string | undefined): Project | undefined {
  if (!userId) return undefined
  try {
    // Never restore the former shared cache into an authenticated account.
    const raw = localStorage.getItem(`${storageKey}:${userId}`)
    if (!raw) return undefined
    return privateProject(JSON.parse(raw) as Project, userId)
  } catch (error) {
    console.error('Failed to load project from local storage.', error)
    return undefined
  }
}

export function downloadText(filename: string, text: string, type = 'text/plain'): void {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
