import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sheet } from '../models/Sheet'
import { loadRemoteProject, saveRemoteProject, saveRemoteSheetHistory } from './supabaseProjectStore'

const mock = vi.hoisted(() => ({ userId: 'alice', queries: [] as { table: string; filters: [string, string][]; write?: unknown }[] }))
vi.mock('./supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: { getUser: async () => ({ data: { user: { id: mock.userId } } }) },
    from: (table: string) => {
      const query = { table, filters: [] as [string, string][], write: undefined as unknown }
      mock.queries.push(query)
      const builder = {
        select: () => builder,
        eq: (key: string, value: string) => { query.filters.push([key, value]); return builder },
        order: () => builder,
        maybeSingle: () => builder,
        upsert: (value: unknown) => { query.write = value; return builder },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === 'sheet_projects' ? null : [], error: null }).then(resolve),
      }
      return builder
    },
  },
}))

const sheet: Sheet = { name: '', width: 100, height: 100, spacing: 10, borderSpacing: 10, instances: [], gcodeSettings: { startGcode: '', spindleStartGcode: '', endGcode: '', safeZ: 5 } }

describe('cloud account boundaries', () => {
  beforeEach(() => { mock.queries = []; mock.userId = 'alice' })

  it('filters every cloud read by the authenticated owner, including empty accounts', async () => {
    const result = await loadRemoteProject('alice')
    expect(result?.items).toEqual([])
    expect(mock.queries).toHaveLength(5)
    for (const query of mock.queries) expect(query.filters).toContainEqual(['owner_id', 'alice'])
  })

  it('does not read or save a snapshot after the session switches accounts', async () => {
    mock.userId = 'bob'
    expect(await loadRemoteProject('alice')).toBeUndefined()
    expect((await saveRemoteProject([], [], sheet, undefined, 'alice')).ok).toBe(false)
    expect((await saveRemoteSheetHistory({ id: 'history', name: '', savedAt: '', sheet, itemCount: 0, componentCount: 0, placedCount: 0 }, 'alice')).ok).toBe(false)
    expect(mock.queries).toEqual([])
  })

  it('rejects foreign and unowned items rather than transferring ownership', async () => {
    for (const ownerId of ['bob', undefined]) {
      const item = { id: 'item', ownerId, name: '', sku: '', description: '', createdAt: '', updatedAt: '' }
      expect((await saveRemoteProject([item], [], sheet, undefined, 'alice')).ok).toBe(false)
    }
    expect(mock.queries).toEqual([])
  })
  it('persists packing measurements on the owner item without changing components', async () => {
    const packing = { paddingMm: 20, separatorMm: 3, components: { panel: { thicknessMm: 12 } } }
    const item = { id: 'item', ownerId: 'alice', name: 'Cabinet', sku: 'CAB', description: '', createdAt: '', updatedAt: '', packing }
    expect((await saveRemoteProject([item], [], sheet, undefined, 'alice')).ok).toBe(true)
    expect(mock.queries.find(q => q.table === 'marketplace_items')?.write).toEqual([expect.objectContaining({ owner_id: 'alice', packing })])
    expect(mock.queries.some(q => q.table === 'cnc_components')).toBe(false)
  })
})
