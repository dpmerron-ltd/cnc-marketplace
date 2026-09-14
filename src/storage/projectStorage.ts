import type { Project } from '../models/Project'

const storageKey = 'sheet-builder-project'

export function saveProject(project: Project): boolean {
  try {
    localStorage.setItem(storageKey, JSON.stringify(project))
    return true
  } catch (error) {
    console.error('Failed to save project to local storage.', error)
    return false
  }
}

export function loadProject(): Project | undefined {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return undefined
    return JSON.parse(raw) as Project
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
