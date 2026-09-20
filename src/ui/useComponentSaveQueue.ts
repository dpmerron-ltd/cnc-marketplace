import { useEffect, useRef, useState } from 'react'
import type { Part } from '../models/Part'

export interface ComponentSaveJob {
  id: string
  ownerId: string
  filename: string
  itemName: string
  part?: Part
  status: 'queued' | 'saving' | 'saved' | 'failed'
  error?: string
}

export function useComponentSaveQueue(ownerId: string | undefined, save: (part: Part) => Promise<void>) {
  const [jobs, setJobs] = useState<ComponentSaveJob[]>([])
  const running = useRef(new Set<string>())
  const owner = useRef(ownerId)
  owner.current = ownerId
  useEffect(() => { setJobs([]) }, [ownerId])
  const visible = jobs.filter(job => job.ownerId === ownerId)
  useEffect(() => {
    if (!ownerId || jobs.some(job => job.ownerId === ownerId && job.status === 'saving')) return
    const job = jobs.find(job => job.ownerId === ownerId && job.status === 'queued')
    if (!job?.part || running.current.has(job.id)) return
    running.current.add(job.id)
    setJobs(current => current.map(entry => entry === job ? { ...entry, status: 'saving', error: undefined } : entry))
    void Promise.resolve().then(() => {
      if (owner.current !== job.ownerId) throw new Error('Account changed before saving.')
      return save(job.part!)
    }).then(() => {
      setJobs(current => current.map(entry => entry.id === job.id ? { ...entry, status: 'saved', part: undefined } : entry))
    }, error => {
      setJobs(current => current.map(entry => entry.id === job.id ? { ...entry, status: 'failed', error: error instanceof Error ? error.message : 'Save failed. Try again.' } : entry))
    }).finally(() => running.current.delete(job.id))
  }, [jobs, ownerId, save])
  const pending = visible.some(job => job.status !== 'saved')
  useEffect(() => {
    if (!pending) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending])
  return {
    jobs: visible, pending,
    enqueue(part: Part, itemName: string) {
      if (!ownerId || part.ownerId !== ownerId) throw new Error('This component is not in your current account.')
      setJobs(current => current.some(job => job.id === part.id) ? current : [...current, { id: part.id, ownerId, filename: part.originalFilename, itemName, part: structuredClone(part), status: 'queued' }])
    },
    retry(id: string) { setJobs(current => current.map(job => job.id === id && job.ownerId === ownerId && job.status === 'failed' ? { ...job, status: 'queued', error: undefined } : job)) },
    clearSaved() { setJobs(current => current.filter(job => job.status !== 'saved')) },
  }
}
