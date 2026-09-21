import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, Layers, RefreshCw, Search, X } from 'lucide-react'
import { jobApiRequest } from '../storage/jobsApi'
import type { ShopifyConnection, ShopifyOrder, ShopifyOrderDetail, ShopifyOrders } from '../orders/types'
import { OrderSheetDialog, type OrderSheetProps } from './OrderSheetDialog'
import './OrdersPage.css'

const orderId = (order: ShopifyOrder) => order.id.split('/').at(-1)!

export function OrdersPage({ userId, sheetTarget }: { userId: string; sheetTarget?: OrderSheetProps }) {
  const [addingOrder, setAddingOrder] = useState('')
  const [connection, setConnection] = useState<ShopifyConnection>()
  const [data, setData] = useState<ShopifyOrders>()
  const [status, setStatus] = useState('open')
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [cursors, setCursors] = useState<string[]>([])
  const [revision, setRevision] = useState(0)
  const [loaded, setLoaded] = useState('')
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<ShopifyOrderDetail>()
  const [detailCursor, setDetailCursor] = useState('')
  const [detailLoaded, setDetailLoaded] = useState('')
  const [detailError, setDetailError] = useState('')
  const [detailRetry, setDetailRetry] = useState(0)
  const after = cursors.at(-1) ?? ''
  const requestKey = JSON.stringify([userId, status, search, after, revision])
  const loading = loaded !== requestKey
  const detailKey = JSON.stringify([userId, selected, detailCursor, detailRetry])
  const detailLoading = detailLoaded !== detailKey

  useEffect(() => {
    const abort = new AbortController()
    void (async () => {
      try {
        const connection: ShopifyConnection = await (await jobApiRequest('/shopify/connection', userId, { signal: abort.signal })).json()
        if (abort.signal.aborted) return
        setConnection(connection)
        if (connection.connected) {
          const params = new URLSearchParams({ status, ...(search ? { search } : {}), ...(after ? { after } : {}) })
          const orders: ShopifyOrders = await (await jobApiRequest(`/shopify/orders?${params}`, userId, { signal: abort.signal })).json()
          if (abort.signal.aborted) return
          setData(orders)
        } else setData(undefined)
        setError('')
      } catch (e) { if (!abort.signal.aborted) { setData(undefined); setError((e as Error).message) } }
      finally { if (!abort.signal.aborted) setLoaded(requestKey) }
    })()
    return () => abort.abort()
  }, [userId, status, search, after, revision, requestKey])

  useEffect(() => {
    if (!selected) return
    const abort = new AbortController()
    void (async () => {
      try {
        const suffix = detailCursor ? `?after=${encodeURIComponent(detailCursor)}` : ''
        const result: ShopifyOrderDetail = await (await jobApiRequest(`/shopify/orders/${selected}${suffix}`, userId, { signal: abort.signal })).json()
        if (abort.signal.aborted) return
        setDetail(previous => detailCursor && previous?.order.id === result.order.id ? { ...result, order: { ...result.order, lineItems: { ...result.order.lineItems, nodes: [...new Map([...previous.order.lineItems.nodes, ...result.order.lineItems.nodes].map(line => [line.id, line])).values()] } } } : result)
        setDetailError('')
      } catch (e) { if (!abort.signal.aborted) setDetailError((e as Error).message) }
      finally { if (!abort.signal.aborted) setDetailLoaded(detailKey) }
    })()
    return () => abort.abort()
  }, [userId, selected, detailCursor, detailRetry, detailKey])

  function closeDetail() { setSelected(''); setDetail(undefined); setDetailCursor(''); setDetailError('') }
  function refresh() { closeDetail(); setCursors([]); setRevision(v => v + 1) }
  return <main className="queue-page orders-page">
    <div className="queue-heading"><div><h2>Orders</h2>{connection?.shop && <p className="orders-store">{connection.shop}</p>}</div><button type="button" className="icon-button" title="Refresh orders" aria-label="Refresh orders" disabled={loading} onClick={refresh}><RefreshCw size={18} /></button></div>
    {error && <p className="queue-error" role="alert">{error}</p>}
    {connection && !connection.connected && !loading && !error ? <p>No Shopify store connected to this account.</p> : <>
      <form className="orders-filters" onSubmit={e => { e.preventDefault(); closeDetail(); setCursors([]); setSearch(draft.trim()); setRevision(v => v + 1) }}>
        <label>Status<select value={status} onChange={e => { closeDetail(); setStatus(e.target.value); setCursors([]) }}><option value="open">Open orders</option><option value="all">All orders</option><option value="unfulfilled">Unfulfilled / partial</option><option value="fulfilled">Fulfilled</option><option value="cancelled">Cancelled</option></select></label>
        <label className="orders-search">Order number<input type="search" maxLength={80} pattern="[a-zA-Z0-9_ #.\-]*" value={draft} onChange={e => setDraft(e.target.value)} placeholder="#1001" /></label>
        <button className="icon-button" type="submit" title="Search orders" aria-label="Search orders"><Search size={18} /></button>
      </form>
      <div className="orders-summary" role="status">{loading ? 'Loading orders...' : data ? `${data.orders.length} orders / Updated ${new Date(data.fetchedAt).toLocaleTimeString()}` : ''}</div>
      {!loading && data && <>
        <div className="queue-table-scroll"><table className="queue-table orders-table"><thead><tr><th>Order</th><th>Items ordered</th>{sheetTarget && <th>Sheet</th>}</tr></thead><tbody>{data.orders.map(order => <tr key={order.id} className={orderId(order) === selected ? 'selected-job' : ''}>
          <td><button type="button" onClick={() => { closeDetail(); setSelected(orderId(order)); setDetailRetry(v => v + 1) }}>{order.name}</button></td>
          <td><ul className="orders-item-list">{order.lineItems.nodes.map(line => <li key={line.id}><strong>{line.quantity} x</strong> {line.title}{line.variantTitle && line.variantTitle !== 'Default Title' ? ` / ${line.variantTitle}` : ''}{line.sku && <span className="queue-order">{line.sku}</span>}{line.currentQuantity !== line.quantity && <span className="queue-order">Current quantity: {line.currentQuantity}</span>}</li>)}</ul>{order.lineItems.pageInfo.hasNextPage && <button type="button" onClick={() => { closeDetail(); setSelected(orderId(order)); setDetailRetry(v => v + 1) }}>All items</button>}</td>
          {sheetTarget && <td><button type="button" className="icon-text-button order-add-button" aria-label={`Add ${order.name} to sheet`} onClick={() => setAddingOrder(orderId(order))}><Layers size={16} /> Add to sheet</button></td>}
        </tr>)}</tbody></table></div>
        {!data.orders.length && <p>No matching orders within the Shopify app's accessible history.</p>}
        <div className="label-pagination"><button type="button" className="icon-button" title="Previous orders" aria-label="Previous orders" disabled={!cursors.length} onClick={() => { closeDetail(); setCursors(c => c.slice(0, -1)) }}><ChevronLeft size={18} /></button><span>Page {cursors.length + 1}</span><button type="button" className="icon-button" title="Next orders" aria-label="Next orders" disabled={!data.pageInfo.hasNextPage || !data.pageInfo.endCursor} onClick={() => { closeDetail(); setCursors(c => [...c, data.pageInfo.endCursor!]) }}><ChevronRight size={18} /></button></div>
      </>}
      {selected && <section className="orders-detail" aria-label="Order details">
        <div className="queue-heading"><h3>{detail?.order.name ?? 'Order details'}</h3><div className="button-row">{detail && <a className="orders-admin" href={`https://${detail.shop}/admin/orders/${selected}`} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Shopify</a>}<button type="button" className="icon-button" title="Close order details" aria-label="Close order details" onClick={closeDetail}><X size={18} /></button></div></div>
        {detailError && <div className="orders-detail-error"><p className="queue-error" role="alert">{detailError}</p><button type="button" className="icon-text-button" disabled={detailLoading} onClick={() => setDetailRetry(v => v + 1)}><RefreshCw size={16} /> Retry details</button></div>}
        {detailLoading && <p role="status">Loading order details...</p>}
        {detail && <>
          <div className="queue-table-scroll"><table className="queue-table orders-lines"><thead><tr><th>Item</th><th>SKU</th><th>Ordered</th><th>Current</th><th>Unfulfilled</th></tr></thead><tbody>{detail.order.lineItems.nodes.map(line => <tr key={line.id}><td>{line.title}{line.variantTitle && line.variantTitle !== 'Default Title' && <span className="queue-order">{line.variantTitle}</span>}</td><td><code>{line.sku || 'No SKU'}</code></td><td>{line.quantity}</td><td>{line.currentQuantity}</td><td>{line.unfulfilledQuantity}</td></tr>)}</tbody></table></div>
          {detail.order.lineItems.pageInfo.hasNextPage && <button type="button" className="icon-text-button" disabled={detailLoading || Boolean(detailError)} onClick={() => setDetailCursor(detail.order.lineItems.pageInfo.endCursor!)}><ChevronRight size={16} /> More items</button>}
        </>}
      </section>}
    </>}
    {addingOrder && sheetTarget && <OrderSheetDialog key={`${userId}:${addingOrder}`} {...sheetTarget} userId={userId} orderId={addingOrder} onClose={() => setAddingOrder('')} />}
  </main>
}
