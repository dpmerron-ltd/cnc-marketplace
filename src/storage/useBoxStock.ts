import { useEffect, useState } from 'react'
import { jobApiRequest } from './jobsApi'
import { boxStockSchema, type BoxStock } from '../packing/boxStock'

export function useBoxStock(userId?: string) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ key: string; boxes?: BoxStock[]; error?: string }>({ key: '' })
  const key = `${userId}:${revision}`
  useEffect(() => {
    if (!userId) return
    const abort = new AbortController()
    void (async () => {
      try {
        const response = await jobApiRequest('/boxes', userId, { signal: abort.signal })
        const boxes = boxStockSchema.array().parse((await response.json()).boxes)
        if (!abort.signal.aborted) setState({ key, boxes })
      } catch (e) { if (!abort.signal.aborted) setState({ key, error: (e as Error).message }) }
    })()
    return () => abort.abort()
  }, [userId, key])
  return { boxes: state.key === key ? state.boxes : undefined, error: state.key === key ? state.error : undefined, loading: state.key !== key, reload: () => setRevision(v => v + 1) }
}
