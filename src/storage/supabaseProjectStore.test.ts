import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sheet } from '../models/Sheet'
import { loadRemoteItemComponents, loadRemoteProject, saveRemoteComponent, saveRemoteItemImage, saveRemoteProject, saveRemoteSheetHistory } from './supabaseProjectStore'
import { testParts } from '../test/jobFixtures'
import { testImage } from '../test/imageFixture'
import { materialProfiles, materialVariantsSchema } from '../cam/materialProfiles'

const mock = vi.hoisted(() => ({ userId: 'alice', conflict: false, error: null as null | { message: string }, project: null as unknown, history: [] as unknown[], failOffset: undefined as number | undefined, rows: [] as unknown[], components: [] as unknown[], queries: [] as { table: string; columns?: string; filters: [string, string][]; included?: [string, string[]]; write?: unknown; options?: unknown; range?: [number, number] }[] }))
vi.mock('./supabaseClient', () => ({
  isSupabaseConfigured: true,
  supabase: {
    rpc: async (name: string, input: { p_actor: string; p_item: string; p_action: string; p_payload: { components?: Record<string, unknown>[]; expected?: Record<string, string>; next?: Record<string, unknown>; image?: unknown } }) => {
      expect(name).toBe('update_item_version')
      const payload = input.p_payload
      mock.queries.push({ table: input.p_action === 'add_components' ? 'cnc_components' : 'marketplace_items', write: payload.components ?? payload.next ?? payload, filters: [['id', input.p_item], ...Object.entries(input.p_action === 'metadata' ? payload.expected ?? {} : {})] })
      if (mock.error || mock.conflict) return { data: null, error: mock.error ?? { message: 'ITEM_VERSION_CONFLICT' } }
      const previous = { id: input.p_item, owner_id: 'alice', name: 'Test', sku: 'TEST', description: '', packing: {}, created_at: '', updated_at: '', ...(mock.rows.find(row => (row as { id: string }).id === input.p_item) as object ?? {}), version_family_id: input.p_item, version_number: 1, version_status: 'published', version_default: false }
      const current = { ...previous, ...payload.next, ...(input.p_action === 'image' ? { image: payload.image } : {}), id: `${input.p_item}-v2`, version_number: 2, version_default: true }
      return { data: { changed: true, previous, current, components: (payload.components ?? []).map(row => ({ ...row, component_family_id: row.id, item_id: current.id })) }, error: null }
    },
    auth: { getUser: async () => ({ data: { user: { id: mock.userId } } }) },
    from: (table: string) => {
      const query = { table, columns: undefined as string | undefined, filters: [] as [string, string][], included: undefined as [string, string[]] | undefined, write: undefined as unknown, options: undefined as unknown, range: undefined as [number, number] | undefined }
      mock.queries.push(query)
      const builder = {
        select: (columns: string) => { query.columns = columns; return builder },
        eq: (key: string, value: string) => { query.filters.push([key, value]); return builder },
        in: (key: string, values: string[]) => { query.included = [key, values]; return builder },
        order: () => builder,
        range: (from: number, to: number) => { query.range = [from, to]; return builder },
        maybeSingle: () => builder,
        single: () => builder,
        update: (value: unknown) => { query.write = value; return builder },
        upsert: (value: unknown, options?: unknown) => { query.write = value; query.options = options; return builder },
        then: (resolve: (value: unknown) => unknown) => {
          const rows = table === 'marketplace_items' ? mock.rows : table === 'sheet_history' ? mock.history : table === 'cnc_components' ? mock.components.filter(row => query.filters.every(([key, value]) => (row as Record<string, unknown>)[key] === value) && (!query.included || query.included[1].includes((row as Record<string, string>)[query.included[0]]))) : []
          const data = query.write ? mock.conflict ? [] : (Array.isArray(query.write) ? query.write : [query.write]) : query.range ? rows?.slice(query.range[0], query.range[1] + 1) : rows
          if (query.write && Array.isArray(query.write) && table === 'marketplace_items' && !mock.conflict && !mock.error) mock.rows = [...mock.rows, ...query.write]
          const error = table === 'cnc_components' && query.range?.[0] === mock.failOffset && mock.failOffset !== undefined ? { message: 'Response too large' } : mock.error
          return Promise.resolve({ data: table === 'sheet_projects' && !query.write ? mock.project : data, error }).then(resolve)
        },
      }
      return builder
    },
  },
}))

const sheet: Sheet = { name: '', width: 100, height: 100, spacing: 10, borderSpacing: 10, instances: [], gcodeSettings: { startGcode: '', spindleStartGcode: '', endGcode: '', safeZ: 5 } }

describe('cloud account boundaries', () => {
  beforeEach(async () => { mock.queries = []; mock.userId = 'alice'; mock.conflict = false; mock.error = null; mock.rows = []; mock.components = []; mock.project = null; mock.history = []; mock.failOffset = undefined; await loadRemoteProject('alice'); mock.queries = [] })

  it('loads a shared item and components from different creators through bounded program pages', async () => {
    const item = { id: 'target', ownerId: 'bob', sku: 'T', name: 'Target', description: '', createdAt: '', updatedAt: '' }
    mock.components = Array.from({ length: 61 }, (_, index) => ({ id: `p-${index}`, owner_id: 'alice', item_id: 'target', sku: `T-${index}`, name: `Panel ${index}`, original_filename: 'panel.nc', gcode: testParts[0].gcode }))
    mock.components.push({ ...(mock.components[0] as object), id: 'foreign', owner_id: 'bob', item_id: 'target' }, { id: 'other', owner_id: 'alice', item_id: 'other' })
    const result = await loadRemoteItemComponents(item, 'alice')
    expect(result).toHaveLength(62)
    expect(result.every(part => part.gcode === testParts[0].gcode && part.itemId === 'target')).toBe(true)
    expect(mock.queries.every(query => query.filters.some(([key, value]) => key === 'item_id' && value === 'target') && !query.filters.some(([key]) => key === 'owner_id'))).toBe(true)
    expect(mock.queries.every(query => query.range![1] - query.range![0] === 24)).toBe(true)
    mock.queries = []
    mock.userId = 'bob'
    await expect(loadRemoteItemComponents(item, 'alice')).rejects.toThrow('account changed')
    expect(mock.queries).toEqual([])
  })

  it('loads a large catalogue completely through bounded shared pages', async () => {
    mock.rows = Array.from({ length: 88 }, (_, index) => ({ id: `item-${index}`, owner_id: 'alice', name: `Item ${index}`, sku: `I${index}` }))
    mock.components = Array.from({ length: 1078 }, (_, index) => ({ id: `part-${index}`, owner_id: 'alice', item_id: `item-${index % 88}`, name: `Panel ${index}`, sku: `P${index}`, original_filename: 'panel.nc', gcode: testParts[0].gcode }))
    const progress = vi.fn()
    const result = await loadRemoteProject('alice', progress)
    expect(result?.items).toHaveLength(88)
    expect(result?.parts).toHaveLength(0)
    expect(result?.componentIndex).toHaveLength(1078)
    expect(new Set(result?.componentIndex?.map(part => part.id)).size).toBe(1078)
    expect(result?.componentIndex?.at(-1)).not.toHaveProperty('gcode')
    const pages = mock.queries.filter(query => query.range)
    expect(pages.every(query => query.range![1] - query.range![0] === 24)).toBe(true)
    expect(pages.every(query => !query.filters.some(([key]) => key === 'owner_id'))).toBe(true)
    expect(pages.filter(query => query.table === 'cnc_components').every(query => query.included?.[0] === 'item_id' && query.included[1].length <= 40)).toBe(true)
    expect(pages.filter(query => query.table === 'cnc_components').every(query => !query.columns?.split(',').some(field => ['*', 'gcode', 'dxf', 'material_variants'].includes(field)))).toBe(true)
  })

  it('reports a failed later page without returning an incomplete library', async () => {
    mock.rows = [{ id: 'item', owner_id: 'alice', name: 'Item', sku: 'ITEM' }]
    mock.components = Array.from({ length: 100 }, (_, index) => ({ id: `part-${index}`, item_id: 'item', owner_id: 'alice' }))
    mock.failOffset = 75
    await expect(loadRemoteProject('alice')).rejects.toThrow('Could not load component index: Response too large')
  })

  it('skips historical bundles at startup while retaining versions and saved-sheet revisions', async () => {
    mock.rows = Array.from({ length: 640 }, (_, index) => ({ id: `version-${index}`, owner_id: 'alice', name: 'Rack', sku: 'RACK', version_family_id: 'family', version_number: index + 1, version_status: 'published', version_default: index === 639 }))
    mock.components = mock.rows.flatMap((row, index) => Array.from({ length: 20 }, (_, part) => ({ id: `part-${index}-${part}`, item_id: (row as { id: string }).id, owner_id: 'alice', name: 'Panel', sku: 'P', original_filename: 'panel.nc', width: 100, height: 200, material_profile: '12', gcode: testParts[0].gcode })))
    const placed = (partId: string) => ({ id: partId, partId, sheetIndex: 0, x: 0, y: 0, rotation: 0, locked: false })
    mock.project = { id: 'alice', selected_item_id: 'version-0', sheet: { ...sheet, instances: [placed('part-0-0'), placed('part-639-0')] } }
    mock.history = [{ id: 'saved', name: 'Saved', saved_at: '', sheet: { ...sheet, instances: [placed('part-1-0'), placed('part-0-0')] } }]
    const result = await loadRemoteProject('alice')
    expect(result?.items).toHaveLength(640)
    expect(result?.componentIndex).toHaveLength(22)
    expect(result?.componentIndex?.map(part => part.id)).toEqual(expect.arrayContaining(['part-0-0', 'part-1-0', 'part-639-0']))
    expect(result?.componentIndex?.every(part => part.materialThicknessMm === 12)).toBe(true)
    expect(result?.sheet).toEqual((mock.project as { sheet: Sheet }).sheet)
    expect(result?.sheetHistory[0].sheet.instances).toHaveLength(2)
    expect(result?.selectedItemId).toBe('version-0')
    const indexQueries = mock.queries.filter(query => query.table === 'cnc_components' && query.range)
    expect(indexQueries).toHaveLength(6)
    expect(indexQueries.every(query => query.included?.[0] === 'item_id'
      ? JSON.stringify(query.included[1]) === JSON.stringify(['version-639'])
      : JSON.stringify(query.included?.[1]) === JSON.stringify(['part-0-0', 'part-1-0']))).toBe(true)
    const profileQueries = mock.queries.filter(query => query.columns?.includes('material_variants->>'))
    expect(profileQueries).toHaveLength(1)
    expect(profileQueries[0].included?.[0]).toBe('id')
    expect(new Set(profileQueries[0].included?.[1])).toEqual(new Set(result?.componentIndex?.map(part => part.id)))
    mock.queries = []
    const historical = await loadRemoteItemComponents(result!.items[0], 'alice')
    expect(historical).toHaveLength(20)
    expect(historical.every(part => part.itemId === 'version-0')).toBe(true)
  })

  it('does not return a partially indexed project when a pinned revision query fails', async () => {
    mock.project = { sheet: { ...sheet, instances: [{ partId: 'old-part' }] } }
    mock.failOffset = 0
    await expect(loadRemoteProject('alice')).rejects.toThrow('Could not load component index')
  })

  it('identifies unreadable profiles instead of silently discarding components', async () => {
    mock.rows = [{ id: 'item', owner_id: 'alice', name: 'Cabinet', sku: 'CAB' }]
    mock.components = [{ id: 'part', item_id: 'item', owner_id: 'alice', name: 'Panel', sku: 'CAB-P1', original_filename: 'panel.nc', gcode: testParts[0].gcode, material_variants: { broken: true } }]
    const project = await loadRemoteProject('alice')
    expect(project?.parts).toEqual([])
    await expect(loadRemoteItemComponents(project!.items[0], 'alice')).rejects.toThrow('CAB-P1: saved cutting profiles could not be read')
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
    const components = await loadRemoteItemComponents(loaded!.items[0], 'alice')
    expect(components[0].metadata.materialVariants).toEqual(materialVariants)
    expect(components[0].gcode).toBe(part.gcode)
    mock.queries = []
    await saveRemoteComponent({ ...testParts[0], ownerId: 'alice' }, 'alice')
    expect(mock.queries[0].write).toEqual([expect.not.objectContaining({ material_variants: expect.anything() })])
  })

  it('saves images separately so stale autosaves never overwrite an API image', async () => {
    const item = { id: 'item', ownerId: 'alice', name: 'Cabinet', sku: 'CAB', description: '', createdAt: '', updatedAt: '', image: testImage }
    await saveRemoteItemImage(item, testImage, 'alice')
    expect(mock.queries[0].options).toEqual({ onConflict: 'id', ignoreDuplicates: true })
    expect(mock.queries[1].write).toEqual({ image: testImage, expected: testImage })
    expect(mock.queries[1].filters).toEqual([['id', 'item']])
    mock.queries = []
    await saveRemoteProject([item], [], sheet, item.id, 'alice')
    expect(mock.queries.some(query => query.table === 'marketplace_items')).toBe(false)
    await saveRemoteItemImage(item, null, 'alice')
    expect(mock.queries.at(-1)?.write).toEqual({ image: null, expected: testImage })
  })

  it('inserts new imports without overwriting existing programs during sheet autosave', async () => {
    const materialVariants = materialVariantsSchema.parse({ version: 1, primaryProfile: '18', profiles: Object.fromEntries(materialProfiles.map(profile => [profile.id, { gcode: testParts[0].gcode, warnings: [], errors: [] }])) })
    const legacy = { ...testParts[0], ownerId: 'alice' }
    const generated = { ...legacy, id: 'generated', metadata: { ...legacy.metadata, materialVariants } }
    const item = { id: legacy.itemId!, ownerId: 'alice', name: 'Test', sku: 'TEST', description: '', createdAt: '', updatedAt: '' }
    expect((await saveRemoteProject([item], [legacy, generated], sheet, item.id, 'alice')).ok).toBe(true)
    const writes = mock.queries.filter(query => query.table === 'cnc_components').map(query => query.write)
    expect(writes).toEqual([[expect.not.objectContaining({ material_variants: expect.anything() }), expect.objectContaining({ material_variants: materialVariants })]])
    expect(mock.queries.filter(query => query.table === 'cnc_components')).toHaveLength(1)
  })

  it('loads validated shared images and rejects stale sessions and failed saves', async () => {
    const row = { id: 'item', owner_id: 'alice', name: 'Cabinet', sku: 'CAB', image: testImage }
    mock.rows = [row, { ...row, id: 'foreign', owner_id: 'bob' }, { ...row, id: 'invalid', image: { contentType: 'image/svg+xml', dataBase64: 'abcd' } }]
    const result = await loadRemoteProject('alice')
    expect(result?.items.map(item => item.id)).toEqual(['item', 'foreign', 'invalid'])
    expect(result?.items[0].image).toEqual(testImage)
    expect(result?.items[2].image).toBeUndefined()
    mock.queries = []
    const item = result!.items[0]
    await expect(saveRemoteItemImage(item, testImage, 'bob')).rejects.toThrow('signed-in account')
    expect(mock.queries).toEqual([])
    mock.error = { message: 'Network failure' }
    await expect(saveRemoteItemImage(item, testImage, 'alice')).rejects.toThrow('Network failure')
  })

  it('saves a confirmed component independently, with a stable ID for retries', async () => {
    const part = { ...testParts[0], ownerId: 'alice' }
    expect(await saveRemoteComponent(part, 'alice')).toMatchObject({ ok: true, part: { id: part.id, itemId: `${part.itemId}-v2` } })
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

  it('shares catalogue reads while filtering personal cloud data by owner', async () => {
    const result = await loadRemoteProject('alice')
    expect(result?.items).toEqual([])
    expect(mock.queries).toHaveLength(6)
    for (const query of mock.queries) {
      if (['marketplace_items', 'cnc_components'].includes(query.table)) expect(query.filters).not.toContainEqual(['owner_id', 'alice'])
      else expect(query.filters).toContainEqual(['owner_id', 'alice'])
    }
  })

  it('does not read or save a snapshot after the session switches accounts', async () => {
    mock.userId = 'bob'
    expect(await loadRemoteProject('alice')).toBeUndefined()
    expect((await saveRemoteProject([], [], sheet, undefined, 'alice')).ok).toBe(false)
    expect((await saveRemoteSheetHistory({ id: 'history', name: '', savedAt: '', sheet, itemCount: 0, componentCount: 0, placedCount: 0 }, 'alice')).ok).toBe(false)
    expect(mock.queries).toEqual([])
  })

  it('does not create unknown items under another creator', async () => {
    for (const ownerId of ['bob', undefined]) {
      const item = { id: 'item', ownerId, name: '', sku: '', description: '', createdAt: '', updatedAt: '' }
      expect((await saveRemoteProject([item], [], sheet, undefined, 'alice')).ok).toBe(false)
    }
    expect(mock.queries).toEqual([])
  })
  it('edits shared metadata without reassigning its creator or rewriting stale unchanged items', async () => {
    mock.rows = [{ id: 'shared', owner_id: 'bob', name: 'Shared', sku: 'SHARED', description: '', packing: {}, created_at: '', updated_at: '' }]
    const loaded = await loadRemoteProject('alice')
    const item = loaded!.items[0]
    mock.queries = []
    expect((await saveRemoteProject([item], [], sheet, item.id, 'alice')).ok).toBe(true)
    expect(mock.queries.some(q => q.table === 'marketplace_items')).toBe(false)
    expect((await saveRemoteProject([{ ...item, name: 'Updated' }], [], sheet, item.id, 'alice')).ok).toBe(true)
    const write = mock.queries.find(q => q.table === 'marketplace_items')!
    expect(write.write).toMatchObject({ name: 'Updated' })
    expect(write.write).not.toHaveProperty('owner_id')
    expect(write.filters).toContainEqual(['name', 'Shared'])
    mock.conflict = true
    expect((await saveRemoteProject([{ ...item, name: 'Conflicting edit' }], [], sheet, item.id, 'alice')).error).toContain('changed in another session')
  })
  it('updates images on another creator’s shared item', async () => {
    mock.rows = [{ id: 'shared', owner_id: 'bob', name: 'Shared', sku: 'SHARED' }]
    const loaded = await loadRemoteProject('alice')
    mock.queries = []
    await saveRemoteItemImage(loaded!.items[0], testImage, 'alice')
    expect(mock.queries).toHaveLength(1)
    expect(mock.queries[0].write).toEqual({ image: testImage, expected: null })
    expect(mock.queries[0].filters).toEqual([['id', 'shared']])
  })
  it('persists packing measurements on the owner item without changing components', async () => {
    const packing = { paddingMm: 20, separatorMm: 3, components: { panel: { thicknessMm: 12 } } }
    const item = { id: 'item', ownerId: 'alice', name: 'Cabinet', sku: 'CAB', description: '', createdAt: '', updatedAt: '', packing }
    expect((await saveRemoteProject([item], [], sheet, undefined, 'alice')).ok).toBe(true)
    expect(mock.queries.find(q => q.table === 'marketplace_items')?.write).toEqual([expect.objectContaining({ owner_id: 'alice', packing })])
    expect(mock.queries.some(q => q.table === 'cnc_components')).toBe(false)
  })
})
