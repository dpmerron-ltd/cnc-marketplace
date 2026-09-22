import { useEffect, useRef, useState } from 'react'
import { Layers, X } from 'lucide-react'
import type { MarketplaceItem } from '../models/Item'
import type { ComponentSummary } from '../models/Part'
import type { ShopifyOrder, ShopifyOrderDetail } from '../orders/types'
import { matchOrderItems, type AddOrderRequest, type NestProgress, type OrderItemMatches } from '../orders/addOrderToSheet'
import { jobApiRequest } from '../storage/jobsApi'

export interface OrderSheetProps {
  items: MarketplaceItem[]
  parts: ComponentSummary[]
  sheetName: string
  onAdd: (request: AddOrderRequest, signal: AbortSignal, onProgress: (progress: NestProgress) => void) => Promise<void>
}

export function OrderSheetDialog({ userId, orderId, items, parts, sheetName, onAdd, onClose }: OrderSheetProps & { userId: string; orderId: string; onClose: () => void }) {
  const [data, setData] = useState<{ order: ShopifyOrder; shop: string }>()
  const [matches, setMatches] = useState<OrderItemMatches>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<NestProgress>()
  const [retry, setRetry] = useState(0)
  const running = useRef<AbortController | undefined>(undefined)
  const dialog = useRef<HTMLDialogElement>(null)
  const catalogue = items.filter(item => item.ownerId === userId)
  const initialItems = useRef(items)

  useEffect(() => { dialog.current?.showModal(); return () => running.current?.abort() }, [])
  useEffect(() => {
    const abort = new AbortController()
    void (async () => {
      try {
        let result: ShopifyOrderDetail | undefined
        const lines = new Map<string, ShopifyOrder['lineItems']['nodes'][number]>()
        const cursors = new Set<string>()
        let after = ''
        do {
          const page: ShopifyOrderDetail = await (await jobApiRequest(`/shopify/orders/${orderId}${after ? `?after=${encodeURIComponent(after)}` : ''}`, userId, { signal: abort.signal })).json()
          if (abort.signal.aborted) return
          if (page.order.id.split('/').at(-1) !== orderId || (result && result.shop !== page.shop)) throw new Error('Order changed while loading. Try again.')
          result = page
          for (const line of page.order.lineItems.nodes) lines.set(line.id, line)
          const info = page.order.lineItems.pageInfo
          after = info.hasNextPage ? info.endCursor ?? '' : ''
          if (info.hasNextPage && (!after || cursors.has(after) || cursors.size >= 100)) throw new Error('Could not load the complete order. Try again.')
          cursors.add(after)
        } while (after)
        const order = { ...result!.order, lineItems: { nodes: [...lines.values()], pageInfo: { hasNextPage: false, endCursor: null } } }
        setData({ order, shop: result!.shop }); setMatches(matchOrderItems(order, initialItems.current, userId)); setError('')
      } catch (e) { if (!abort.signal.aborted) setError((e as Error).message) }
    })()
    return () => abort.abort()
  }, [userId, orderId, retry])

  const lines = data?.order.lineItems.nodes.filter(line => line.currentQuantity > 0) ?? []
  const countFor = (id: string) => parts.filter(part => part.ownerId === userId && part.itemId === id).length
  const count = lines.reduce((sum, line) => sum + countFor(matches[line.id]) * line.currentQuantity, 0)
  const ready = lines.length > 0 && lines.every(line => catalogue.some(item => item.id === matches[line.id]) && countFor(matches[line.id]) > 0)
  async function add() {
    if (!data || !ready || running.current) return
    const abort = new AbortController(); running.current = abort; setBusy(true); setError(''); setProgress({ completed: 0, total: count })
    try { await onAdd({ ...data, matches }, abort.signal, setProgress); if (!abort.signal.aborted) onClose() }
    catch (e) { if (!abort.signal.aborted) setError((e as Error).message) }
    finally { if (running.current === abort) { running.current = undefined; setBusy(false); setProgress(undefined) } }
  }
  return <dialog ref={dialog} className="order-sheet-dialog" aria-labelledby="order-sheet-title" onCancel={onClose}>
    <div className="queue-heading"><h3 id="order-sheet-title">Add {data?.order.name ?? 'order'} to sheet</h3><button type="button" className="icon-button" title="Close" aria-label="Close add order" onClick={onClose}><X size={18} /></button></div>
    <p className="orders-store">Sheet: {sheetName}</p>
    {error && <p role="alert" className="queue-error">{error}</p>}
    {!data && !error && <p role="status">Loading all order items...</p>}
    {!data && error && <button type="button" onClick={() => { setError(''); setRetry(value => value + 1) }}>Retry</button>}
    {data && <>
      {lines.map(line => <div className="order-sheet-line" key={line.id}>
        <div><strong>{line.currentQuantity} x {line.title}</strong>{line.variantTitle && line.variantTitle !== 'Default Title' && <span className="queue-order">{line.variantTitle}</span>}<span className="queue-order">SKU: {line.sku || 'Not supplied'}</span></div>
        <label>Catalogue item<select aria-label={`Catalogue item for ${line.title}`} disabled={busy} value={matches[line.id] ?? ''} onChange={e => setMatches(current => ({ ...current, [line.id]: e.target.value }))}><option value="">Select item</option>{catalogue.map(item => <option key={item.id} value={item.id}>{item.sku} / {item.name} ({countFor(item.id)} components)</option>)}</select></label>
      </div>)}
      {!lines.length && <p>This order has no current items to add.</p>}
      <div className="order-sheet-actions"><span role="status">{busy ? `Nesting ${progress?.completed ?? 0}/${progress?.total ?? count}` : `${count} components / current order quantities`}</span><div className="button-row"><button type="button" onClick={onClose}>{busy ? 'Cancel' : 'Close'}</button><button type="button" className="icon-text-button" disabled={!ready || busy} onClick={() => void add()}><Layers size={16} /> Add components</button></div></div>
    </>}
  </dialog>
}
