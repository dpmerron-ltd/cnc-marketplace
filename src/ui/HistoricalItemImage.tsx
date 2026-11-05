import { useEffect, useState } from 'react'
import { itemImageUrl, type ItemImage } from '../models/ItemImage'
import { loadRemoteItemImage } from '../storage/supabaseProjectStore'

export function HistoricalItemImage({ itemId, userId, name }: { itemId: string; userId: string; name: string }) {
  const [retry, setRetry] = useState(0)
  const request = `${userId}:${itemId}:${retry}`
  const [result, setResult] = useState<{ request: string; image?: ItemImage; error?: string }>()
  useEffect(() => {
    let active = true
    void loadRemoteItemImage(itemId, userId)
      .then(image => { if (active) setResult({ request, image }) })
      .catch(error => { if (active) setResult({ request, error: error instanceof Error ? error.message : 'Could not load image.' }) })
    return () => { active = false }
  }, [itemId, userId, request])
  if (result?.request !== request) return <p role="status">Loading item image...</p>
  if (result.error) return <p role="alert">{result.error} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry image</button></p>
  return result.image ? <img className="items-version-image" src={itemImageUrl(result.image)} alt={name} /> : null
}
