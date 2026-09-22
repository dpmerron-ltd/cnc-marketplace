import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sheet } from '../models/Sheet'
import { loadRemoteProject, saveRemoteComponent, saveRemoteItemImage, saveRemoteProject, saveRemoteSheetHistory } from './supabaseProjectStore'
import { testParts } from '../test/jobFixtures'
import { testImage } from '../test/imageFixture'
import { materialProfiles, materialVariantsSchema } from '../cam/materialProfiles'

const mock = vi.hoisted(() => ({ userId: 'alice', error: null as null | { message: string }, failOffset: undefined as number | undefined, rows: [] as unknown[], components: [] as unknown[], queries: [] as { table: string; filters: [string, string][]; write?: unknown; options?: unknown; range?: [number, number] }[] }))
vi.mock('./supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: { getUser: async () => ({ data: { user: { id: mock.userId } } }) },
    from: (table: string) => {
      const query = { table, filters: [] as [string, string][], write: undefined as unknown, options: undefined as unknown, range: undefined as [number, number] | undefined }
      mock.queries.push(query)
      const builder = {
        select: () => builder,
        eq: (key: string, value: string) => { query.filters.push([key, value]); return builder },
        order: () => builder,
        range: (from: number, to: number) => { query.range = [from, to]; return builder },
        maybeSingle: () => builder,
        single: () => builder,
        update: (value: unknown) => { query.write = value; return builder },
        upsert: (value: unknown, options?: unknown) => { query.write = value; query.options = options; return builder },
        then: (resolve: (value: unknown) => unknown) => {
          const rows = table === 'sheet_projects' ? null : table === 'marketplace_items' ? mock.rows : table === 'cnc_components' ? mock.components : []
          const data = query.range ? rows?.slice(query.range[0], query.range[1] + 1) : rows
          const error = table === 'cnc_components' && query.range?.[0] === mock.failOffset && mock.failOffset !== undefined ? { message: 'Response too large' } : mock.error
          return Promise.resolve({ data, error }).then(resolve)
        },
      }
      return builder
    },
  },
}))

const sheet: Sheet = { name: '', width: 100, height: 100, spacing: 10, borderSpacing: 10, instances: [], gcodeSettings: { startGcode: '', spindleStartGcode: '', endGcode: '', safeZ: 5 } }

describe('cloud account boundaries', () => {
  beforeEach(() => { mock.queries = []; mock.userId = 'alice'; mock.error = null; mock.rows = []; mock.components = []; mock.failOffset = undefined })

  it('loads a large catalogue completely through bounded owner-filtered pages', async () => {
    mock.rows = Array.from({ length: 88 }, (_, index) => ({ id: `item-${index}`, owner_id: 'alice', name: `Item ${index}`, sku: `I${index}` }))
    mock.components = Array.from({ length: 1078 }, (_, index) => ({ id: `part-${index}`, owner_id: 'alice', item_id: `item-${index % 88}`, name: `Panel ${index}`, sku: `P${index}`, original_filename: 'panel.nc', gcode: testParts[0].gcode }))
    const progress = vi.fn()
    const result = await loadRemoteProject('alice', progress)
    expect(result?.items).toHaveLength(88)
    expect(result?.parts).toHaveLength(1078)
    expect(new Set(result?.parts.map(part => part.id)).size).toBe(1078)
    expect(result?.parts.at(-1)?.gcode).toBe(testParts[0].gcode)
    const pages = mock.queries.filter(query => query.range)
    expect(pages.every(query => query.range![1] - query.range![0] === 24)).toBe(true)
    expect(pages.every(query => query.filters.some(([key, value]) => key === 'owner_id' && value === 'alice'))).toBe(true)
    expect(progress).toHaveBeenCalledWith('Preparing cutting components: 1075 of 1078…')
  })

  it('reports a failed later page without returning an incomplete library', async () => {
    mock.components = Array.from({ length: 100 }, (_, index) => ({ id: `part-${index}` }))
    mock.failOffset = 75
    await expect(loadRemoteProject('alice')).rejects.toThrow('Could not load cutting components: Response too large')
  })

  it('identifies unreadable profiles instead of silently discarding components', async () => {
    mock.rows = [{ id: 'item', owner_id: 'alice', name: 'Cabinet', sku: 'CAB' }]
    mock.components = [{ id: 'part', item_id: 'item', owner_id: 'alice', name: 'Panel', sku: 'CAB-P1', original_filename: 'panel.nc', gcode: testParts[0].gcode, material_variants: { broken: true } }]
    await expect(loadRemoteProject('alice')).rejects.toThrow('CAB-P1: saved cutting profiles could not be read')
  })

  it('round-trips owned material variants separately so legacy metadata autosaves cannot erase them', async () => {
    const materialVariants = materialVariantsSchema.parse({ version: 1, primaryProfile: '18', profiles: Object.fromEntries(materialProfiles.map(profile => [profile.id, { gcode: testParts[0].gcode, warnings: [], errors: [] }])) })
    const part = { ...testParts[0], ownerId: 'alice', metadata: { ...testParts[0].metadata, materialVariants } }
    await saveRemoteComponent(part, 'alice')
    const rows = mock.queries[0].write as unknown[]
    expect(rows).toEqual([expect.objectContaining({ material_variants: materialVariants, metadata: testParts[0].metadata })])
    mock.components = rows
    mock.rows = [{ id: part.itemId, owner_id: 'alice', name: 'Test', sku: 'TEST' }]
    const loaded = await loadRemoteProject('alice')
    expect(loaded?.parts[0].metadata.materialVariants).toEqual(materialVariants)
    expect(loaded?.parts[0].gcode).toBe(part.gcode)
    mock.queries = []
    await saveRemoteComponent({ ...testParts[0], ownerId: 'alice' }, 'alice')
    expect(mock.queries[0].write).toEqual([expect.not.objectContaining({ material_variants: expect.anything() })])
  })

  it('saves images separately so stale autosaves never overwrite an API image', async () => {
    const item = { id: 'item', ownerId: 'alice', name: 'Cabinet', sku: 'CAB', description: '', createdAt: '', updatedAt: '', image: testImage }
    await saveRemoteItemImage(item, testImage, 'alice')
    expect(mock.queries[0].options).toEqual({ onConflict: 'id', ignoreDuplicates: true })
    expect(mock.queries[1].write).toEqual({ image: testImage, updated_at: expect.any(String) })
    expect(mock.queries[1].filters).toEqual([['id', 'item'], ['owner_id', 'alice']])
    mock.queries = []
    await saveRemoteProject([item], [], sheet, item.id, 'alice')
    expect(mock.queries[0].write).toEqual([expect.not.objectContaining({ image: expect.anything() })])
    await saveRemoteItemImage(item, null, 'alice')
    expect(mock.queries.at(-1)?.write).toEqual({ image: null, updated_at: expect.any(String) })
  })

  it('inserts new imports without overwriting existing programs during sheet autosave', async () => {
    const materialVariants = materialVariantsSchema.parse({ version: 1, primaryProfile: '18', profiles: Object.fromEntries(materialProfiles.map(profile => [profile.id, { gcode: testParts[0].gcode, warnings: [], errors: [] }])) })
    const legacy = { ...testParts[0], ownerId: 'alice' }
    const generated = { ...legacy, id: 'generated', metadata: { ...legacy.metadata, materialVariants } }
    const item = { id: legacy.itemId!, ownerId: 'alice', name: 'Test', sku: 'TEST', description: '', createdAt: '', updatedAt: '' }
    expect((await saveRemoteProject([item], [legacy, generated], sheet, item.id, 'alice')).ok).toBe(true)
    const writes = mock.queries.filter(query => query.table === 'cnc_components').map(query => query.write)
    expect(writes).toEqual([
      [expect.not.objectContaining({ material_variants: expect.anything() })],
      [expect.objectContaining({ material_variants: materialVariants })],
    ])
    expect(mock.queries.filter(query => query.table === 'cnc_components').map(query => query.options)).toEqual([
      { onConflict: 'id', ignoreDuplicates: true },
      { onConflict: 'id', ignoreDuplicates: true },
    ])
  })

  it('loads only validated owner images and rejects foreign image writes and failed saves', async () => {
    const row = { id: 'item', owner_id: 'alice', name: 'Cabinet', sku: 'CAB', image: testImage }
    mock.rows = [row, { ...row, id: 'foreign', owner_id: 'bob' }, { ...row, id: 'invalid', image: { contentType: 'image/svg+xml', dataBase64: 'abcd' } }]
    const result = await loadRemoteProject('alice')
    expect(result?.items.map(item => item.id)).toEqual(['item', 'invalid'])
    expect(result?.items[0].image).toEqual(testImage)
    expect(result?.items[1].image).toBeUndefined()
    mock.queries = []
    const item = result!.items[0]
    await expect(saveRemoteItemImage(item, testImage, 'bob')).rejects.toThrow('signed-in account')
    await expect(saveRemoteItemImage({ ...item, ownerId: 'bob' }, testImage, 'alice')).rejects.toThrow('signed-in account')
    expect(mock.queries).toEqual([])
    mock.error = { message: 'Network failure' }
    await expect(saveRemoteItemImage(item, testImage, 'alice')).rejects.toThrow('Network failure')
  })

  it('saves a confirmed component independently, with a stable ID for retries', async () => {
    const part = { ...testParts[0], ownerId: 'alice' }
    expect(await saveRemoteComponent(part, 'alice')).toEqual({ ok: true })
    expect(mock.queries).toHaveLength(1)
    expect(mock.queries[0].table).toBe('cnc_components')
    expect(mock.queries[0].write).toEqual([expect.objectContaining({ id: part.id, owner_id: 'alice', item_id: part.itemId, gcode: part.gcode })])
    mock.error = { message: 'Storage unavailable' }
    expect(await saveRemoteComponent(part, 'alice')).toEqual({ ok: false, error: 'Storage unavailable' })
    expect(mock.queries[1].write).toEqual(mock.queries[0].write)
  })

  it('does not save confirmed components for another session or owner', async () => {
    const part = { ...testParts[0], ownerId: 'alice' }
    expect((await saveRemoteComponent(part, 'bob')).ok).toBe(false)
    expect((await saveRemoteComponent({ ...part, ownerId: 'bob' }, 'alice')).ok).toBe(false)
    expect((await saveRemoteComponent({ ...part, itemId: undefined }, 'alice')).ok).toBe(false)
    expect(mock.queries).toEqual([])
  })

  it('filters every cloud read by the authenticated owner, including empty accounts', async () => {
    const result = await loadRemoteProject('alice')
    expect(result?.items).toEqual([])
    expect(mock.queries).toHaveLength(9)
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
