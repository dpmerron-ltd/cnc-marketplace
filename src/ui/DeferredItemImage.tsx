import { useEffect, useRef, useState } from 'react'

// Fetch bytes only for cards near the viewport, not merely mounted cards.
export function DeferredItemImage({ itemId, onLoad, eager = false }: { itemId: string; onLoad: (itemId: string) => Promise<void>; eager?: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(eager)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (eager || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '200px' })
    if (container.current) observer.observe(container.current)
    return () => observer.disconnect()
  }, [eager])
  useEffect(() => {
    if (!visible) return
    let active = true
    void onLoad(itemId).catch(failure => {
      if (active) setError(failure instanceof Error ? failure.message : 'Could not load image.')
    })
    return () => { active = false }
  }, [itemId, onLoad, visible, retry])
  return <div ref={container} className="items-preview item-photo">
    {error ? <span>{eager ? <><span role="alert">{error}</span><button type="button" onClick={() => { setError(''); setRetry(value => value + 1) }}>Retry image</button></> : 'Image unavailable — open item to retry'}</span> : <span>{visible ? 'Loading image…' : 'Item image'}</span>}
  </div>
}
