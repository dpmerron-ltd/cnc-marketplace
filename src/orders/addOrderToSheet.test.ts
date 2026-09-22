import { afterEach, describe, expect, it, vi } from 'vitest'
import { matchOrderItems, nestOrder, prepareOrderSheet } from './addOrderToSheet'
import { testItem, testParts } from '../test/jobFixtures'
import { autoNest } from '../nesting/nestingEngine'
import { validateSheet } from '../gcode/validator'
import type { Sheet } from '../models/Sheet'
import type { ShopifyOrder } from './types'

const item = { ...testItem, ownerId: 'alice', sku: 'VS-0003' }
const parts = testParts.map(part => ({ ...part, ownerId: 'alice', itemId: item.id }))
const sheet: Sheet = { name: 'Existing job', orderNumber: '#1006', width: 160, height: 100, spacing: 30, borderSpacing: 10, instances: [], gcodeSettings: { startGcode: '', spindleStartGcode: '', endGcode: '', safeZ: 20 } }
const line = { id: 'line1', title: 'Rack', sku: 'vs-0003 ', variantTitle: null, quantity: 3, currentQuantity: 2, unfulfilledQuantity: 1 }
const order: ShopifyOrder = { id: 'gid://shopify/Order/7', name: '#1007', lineItems: { nodes: [line], pageInfo: { hasNextPage: false, endCursor: null } } }
const request = { order, shop: 'test.myshopify.com', matches: { line1: item.id } }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('add Shopify order to sheet', () => {
  it('matches unique SKUs in the shared catalogue, never guesses missing or duplicate SKUs', () => {
    expect(matchOrderItems(order, [item, { ...item, id: 'foreign', ownerId: 'bob' }], 'alice')).toEqual({ line1: '' })
    expect(matchOrderItems(order, [item], 'bob')).toEqual({ line1: item.id })
    expect(matchOrderItems(order, [item, { ...item, id: 'duplicate' }], 'alice')).toEqual({ line1: '' })
    expect(matchOrderItems({ ...order, lineItems: { ...order.lineItems, nodes: [{ ...line, sku: null }] } }, [item], 'alice')).toEqual({ line1: '' })
  })
  it('adds every component for current quantities, preserves existing placements, spills to sheets and numbers parts', () => {
    const original = { id: 'existing', partId: parts[0].id, sheetIndex: 1, x: 10, y: 10, rotation: 0, locked: false, partNumber: 1 }
    const input = { ...sheet, instances: [original] }
    const prepared = prepareOrderSheet(request, [item], parts, input, 'alice', 1)
    const result = prepared.finish(autoNest(prepared.parts, prepared.sheet))
    expect(result.instances[0]).toEqual(original)
    expect(result.instances).toHaveLength(5)
    for (const part of parts) expect(result.instances.slice(1).filter(instance => instance.partId === part.id)).toHaveLength(2)
    expect(result.instances.every(instance => instance.sheetIndex >= 1)).toBe(true)
    expect(Math.max(...result.instances.map(instance => instance.sheetIndex))).toBeGreaterThan(1)
    expect(new Set(result.instances.map(instance => instance.partNumber)).size).toBe(5)
    expect(validateSheet(parts, result).filter(issue => issue.level === 'error')).toEqual([])
    expect(result.orderNumber).toBe('#1006, #1007')
    expect(input.instances).toEqual([original])
    expect(() => prepareOrderSheet(request, [item], parts, result, 'alice', 0)).toThrow('already on this sheet')
    expect(() => prepareOrderSheet(request, [item], parts, { ...result, instances: [] }, 'alice', 0)).not.toThrow()
  })
  it('includes multiple line items and repeated SKUs, skips removed quantities and includes components from other creators', () => {
    const multiple = { ...request, order: { ...order, lineItems: { ...order.lineItems, nodes: [line, { ...line, id: 'line2', currentQuantity: 1 }, { ...line, id: 'removed', currentQuantity: 0 }] } }, matches: { line1: item.id, line2: item.id } }
    const prepared = prepareOrderSheet(multiple, [item], [...parts, { ...parts[0], id: 'foreign', ownerId: 'bob' }], sheet, 'alice', 0)
    expect(prepared.count).toBe(9)
    expect(prepared.sheet.instances.some(instance => instance.partId === 'foreign')).toBe(true)
  })
  it('rejects incomplete orders, unmapped items, signed-out requests, empty components and invalid quantities atomically', () => {
    expect(() => prepareOrderSheet({ ...request, order: { ...order, lineItems: { ...order.lineItems, pageInfo: { hasNextPage: true, endCursor: 'next' } } } }, [item], parts, sheet, 'alice', 0)).toThrow('Load all')
    expect(() => prepareOrderSheet({ ...request, matches: {} }, [item], parts, sheet, 'alice', 0)).toThrow('select an item')
    expect(() => prepareOrderSheet(request, [item], parts, sheet, '', 0)).toThrow('Sign in')
    expect(() => prepareOrderSheet(request, [item], [], sheet, 'alice', 0)).toThrow('no components')
    for (const quantity of [-1, 0.5, NaN, 100000]) {
      expect(() => prepareOrderSheet({ ...request, order: { ...order, lineItems: { ...order.lineItems, nodes: [{ ...line, currentQuantity: quantity }] } } }, [item], parts, sheet, 'alice', 0)).toThrow()
    }
    expect(sheet.instances).toEqual([])
  })
  it('requires valid G-code for the selected sheet thickness and rejects incomplete worker output', () => {
    expect(() => prepareOrderSheet(request, [item], parts, { ...sheet, materialProfile: '12' }, 'alice', 0)).toThrow('G-code unavailable')
    const prepared = prepareOrderSheet(request, [item], parts, sheet, 'alice', 0)
    expect(() => prepared.finish([])).toThrow('incomplete order')
  })
})

describe('order nesting worker', () => {
  const workers: WorkerMock[] = []
  class WorkerMock {
    onmessage?: (event: { data: unknown }) => void
    onerror?: () => void
    onmessageerror?: () => void
    terminate = vi.fn()
    postMessage = vi.fn()
    constructor() { workers.push(this) }
  }
  function start() {
    vi.stubGlobal('Worker', WorkerMock)
    const abort = new AbortController(), progress = vi.fn()
    const promise = nestOrder(parts, sheet, abort.signal, progress)
    return { abort, progress, promise, worker: workers.at(-1)! }
  }
  it('reports progress and terminates on completion', async () => {
    const { promise, progress, worker } = start()
    worker.onmessage!({ data: { progress: { completed: 1, total: 2 } } })
    expect(progress).toHaveBeenCalledWith({ completed: 1, total: 2 })
    worker.onmessage!({ data: { instances: [] } })
    await expect(promise).resolves.toEqual([])
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
  it('cancels without applying a partial layout', async () => {
    const { abort, promise, worker } = start()
    abort.abort()
    await expect(promise).rejects.toThrow('cancelled')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
  it('times out after 30 seconds and terminates the worker', async () => {
    vi.useFakeTimers()
    const { promise, worker } = start()
    const failure = expect(promise).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(30000)
    await failure
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
  it('surfaces validation failures', async () => {
    const { promise, worker } = start()
    worker.onmessage!({ data: { error: 'Part violates border spacing.' } })
    await expect(promise).rejects.toThrow('border spacing')
  })
})
