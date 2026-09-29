// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseRepository } from './repository'
import { sha256 } from '../src/jobs/generateJob'
import { testImage } from '../src/test/imageFixture'
import { testItem, testParts } from '../src/test/jobFixtures'
import { materialProfiles, materialVariantsSchema } from '../src/cam/materialProfiles'
import * as simulation from '../src/gcode/simulator'

function fixture() {
  const query = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), gt: vi.fn(), maybeSingle: vi.fn(async () => ({ data: { id: 'key-id', owner_id: 'alice' }, error: null })) }
  for (const method of ['select', 'eq', 'is', 'gt'] as const) query[method].mockReturnValue(query)
  const db = { from: vi.fn(() => query), auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'alice' } }, error: null })), getClaims: vi.fn(async () => ({ data: { claims: { sub: 'alice', aal: 'aal2' } }, error: null })) } }
  return { query, db, repo: supabaseRepository(db as unknown as SupabaseClient) }
}
describe('API credential verification', () => {
  it('returns exact source and revision through item and component filters for any authenticated user', async () => {
    const row = { id: 'part', item_id: 'item', name: 'Panel', sku: 'P1', original_filename: 'panel.nc', gcode: testParts[0].gcode, dxf: 'original DXF', material_variants: null }
    let data: typeof row | null = row
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data, error: null })) }
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query)
    const repo = supabaseRepository({ from: () => query } as unknown as SupabaseClient)
    expect(await repo.componentSource('alice', 'item', 'part')).toEqual({ id: 'part', itemId: 'item', name: 'Panel', sku: 'P1', filename: 'panel.nc', gcode: row.gcode, dxf: row.dxf, materialVariants: null, sha256: await sha256(row.gcode) })
    for (const pair of [['item_id', 'item'], ['id', 'part']]) expect(query.eq).toHaveBeenCalledWith(...pair)
    data = null
    expect(await repo.componentSource('alice', 'item', 'missing')).toBeUndefined()
  })

  it('passes authenticated identity into scoped order RPCs and reports assignment conflicts', async () => {
    const rpc = vi.fn(async (_name: string, _args: unknown): Promise<{ data: unknown; error: { message: string } | null }> => ({ data: [], error: null }))
    const repo = supabaseRepository({ rpc } as unknown as SupabaseClient)
    await repo.orderUsers('dan', 100)
    expect(rpc).toHaveBeenLastCalledWith('cnc_order_users', { p_actor: 'dan', p_offset: 100 })
    await repo.orderAssignments('bob', 'test.myshopify.com', ['123'])
    expect(rpc).toHaveBeenLastCalledWith('read_cnc_order_assignments', { p_actor: 'bob', p_shop: 'test.myshopify.com', p_ids: ['123'], p_offset: 0, p_search: '' })
    const input = { assigneeId: 'bob', paymentPence: 4500, expectedVersion: 2 }
    await repo.assignOrder('dan', 'test.myshopify.com', '123', '#1007', input)
    expect(rpc).toHaveBeenLastCalledWith('assign_cnc_order', { p_actor: 'dan', p_shop: 'test.myshopify.com', p_order_id: '123', p_order_name: '#1007', p_assignee: 'bob', p_payment_pence: 4500, p_expected_version: 2 })
    rpc.mockResolvedValue({ data: null, error: { message: 'ORDER_REVISION_CONFLICT' } })
    await expect(repo.assignOrder('dan', 'test.myshopify.com', '123', '#1007', input)).rejects.toMatchObject({ status: 409 })
  })
  it('shares inventory while recording the acting account and mapping revision conflicts', async () => {
    const row = { id: crypto.randomUUID(), name: 'Box', length_mm: 1050, width_mm: 350, height_mm: 400, quantity: 10, version: 1, updated_at: '2026-09-21', details: '' }
    const calls: { method: string; args: unknown[] }[] = []
    const query: Record<string, (...args: unknown[]) => unknown> = {}
    for (const method of ['select', 'eq', 'insert', 'order']) query[method] = (...args) => { calls.push({ method, args }); return query }
    query.then = (resolve) => (resolve as (value: unknown) => unknown)({ data: [row], error: null })
    query.single = async () => ({ data: row, error: null })
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'BOX_REVISION_CONFLICT' } }))
    const repo = supabaseRepository({ from: () => query, rpc } as unknown as SupabaseClient)
    expect(await repo.boxes('alice')).toEqual([row])
    expect(calls.some(call => call.method === 'eq')).toBe(false)
    const { version: _version, updated_at: _updated, ...input } = row
    await repo.createBox('alice', input)
    expect(calls).toContainEqual({ method: 'insert', args: [{ ...input, updated_by: 'alice' }] })
    await expect(repo.countBox('bob', row.id, { quantity: 9, expectedVersion: 1 })).rejects.toMatchObject({ status: 409 })
    expect(rpc).toHaveBeenCalledWith('count_cnc_boxes', { p_actor: 'bob', p_id: row.id, p_quantity: 9, p_expected_version: 1 })
  })
  it.each(['20000000-0000-4000-8000-000000000001', 'peg-board-18mm-138ac2cd'])('validates replacement of %s before a shared compare-and-swap, preserving source and identity', async id => {
    const row = { id, name: 'Side', sku: 'SIDE', original_filename: 'side.nc', dxf: 'original DXF' }
    let found = true
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: found ? row : null, error: null })) }
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query)
    const rpc = vi.fn(async (_name: string, _args: unknown): Promise<{ data: unknown; error: { message: string } | null }> => ({ data: { current: { id: 'version-2' }, components: [{ id: 'part-version-2', component_family_id: id }] }, error: null }))
    const repo = supabaseRepository({ from: () => query, rpc } as unknown as SupabaseClient)
    const gcode = testParts[0].gcode
    const materialVariants = materialVariantsSchema.parse({ version: 1, primaryProfile: '18', profiles: Object.fromEntries(materialProfiles.map(p => [p.id, { gcode, errors: [], warnings: [] }])) })
    const input = { gcode, materialVariants, expectedSha256: 'a'.repeat(64), expectedMaterialVariants: null }
    const result = await repo.replaceComponent('alice', testItem.id, id, input)
    expect(result.part).toMatchObject({ id: 'part-version-2', name: row.name, sku: row.sku, dxf: row.dxf, originalFilename: row.original_filename, ownerId: 'alice', itemId: 'version-2' })
    for (const pair of [['item_id', testItem.id], ['id', id]]) expect(query.eq).toHaveBeenCalledWith(...pair)
    expect(rpc).toHaveBeenCalledWith('update_item_version', expect.objectContaining({ p_actor: 'alice', p_item: testItem.id, p_action: 'replace_component', p_payload: expect.objectContaining({ id, expectedSha256: input.expectedSha256, expectedMaterialVariants: null, expectedDxf: row.dxf, component: expect.objectContaining({ gcode, material_variants: materialVariants, width: result.part.width }) }) }))
    rpc.mockClear()
    const corrected = await repo.replaceComponent('alice', testItem.id, id, { ...input, dxf: 'corrected source DXF', expectedDxf: row.dxf })
    expect(corrected.part.dxf).toBe('corrected source DXF')
    expect(rpc).toHaveBeenCalledWith('update_item_version', expect.objectContaining({ p_actor: 'alice', p_payload: expect.objectContaining({ expectedDxf: row.dxf, component: expect.objectContaining({ dxf: 'corrected source DXF', gcode, material_variants: materialVariants }) }) }))
    rpc.mockClear()
    await expect(repo.replaceComponent('alice', testItem.id, id, { ...input, dxf: 'corrected source DXF', expectedDxf: 'stale source' })).rejects.toMatchObject({ status: 409 })
    expect(rpc).not.toHaveBeenCalled()
    rpc.mockClear()
    await expect(repo.replaceComponent('alice', testItem.id, id, { ...input, gcode: 'G20\nG91\n' })).rejects.toThrow()
    expect(rpc).not.toHaveBeenCalled()
    rpc.mockResolvedValue({ data: null, error: { message: 'COMPONENT_REVISION_CONFLICT' } })
    await expect(repo.replaceComponent('alice', testItem.id, id, input)).rejects.toMatchObject({ status: 409 })
    found = false; rpc.mockClear()
    await expect(repo.replaceComponent('bob', testItem.id, id, input)).rejects.toMatchObject({ status: 404 })
    expect(rpc).not.toHaveBeenCalled()
  })
  it('reuses stored validation only when the request expects that exact stored revision', async () => {
    const id = '20000000-0000-4000-8000-000000000001', gcode = testParts[0].gcode
    const materialVariants = materialVariantsSchema.parse({ version: 1, primaryProfile: '18', profiles: Object.fromEntries(materialProfiles.map(p => [p.id, { gcode, errors: [], warnings: [] }])) })
    const row = { id, name: 'Side', sku: 'SIDE', original_filename: 'side.nc', dxf: 'DXF', material_variants: materialVariants }
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: row, error: null })) }
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query)
    const rpc = vi.fn(async () => ({ data: { current: { id: 'version-2' }, components: [{ id: 'part-version-2', component_family_id: id }] }, error: null }))
    const repo = supabaseRepository({ from: () => query, rpc } as unknown as SupabaseClient)
    const input = { gcode, materialVariants, expectedSha256: 'a'.repeat(64), expectedMaterialVariants: materialVariants }
    const simulate = vi.spyOn(simulation, 'simulateGCode')
    try {
      await repo.replaceComponent('alice', testItem.id, id, input)
      expect(simulate).toHaveBeenCalledTimes(1)
      simulate.mockClear()
      await repo.replaceComponent('alice', testItem.id, id, { ...input, expectedMaterialVariants: null })
      expect(simulate.mock.calls.length).toBeGreaterThan(1)
    } finally { simulate.mockRestore() }
  })
  it('attributes new components to the caller and replays identical shared uploads', async () => {
    const part = { ...testParts[0], ownerId: 'alice', itemId: testItem.id }
    let parentExists = true, duplicate = false, changed = false
    const inserts: unknown[] = [], filters: [string, unknown][] = []
    const db = { rpc: vi.fn(async (_name: string, input: { p_actor: string; p_payload: { components: unknown[] } }) => {
      inserts.push(...input.p_payload.components)
      return { data: { changed: !duplicate, current: { id: 'next-item' }, components: [{ id: part.id, component_family_id: part.id }] }, error: changed || input.p_actor !== 'alice' ? { message: 'ITEM_VERSION_CONFLICT' } : null }
    }), from(table: string) {
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query },
        insert: async (value: unknown) => { inserts.push(value); return { data: null, error: duplicate ? { code: '23505', message: 'Duplicate' } : null } },
        maybeSingle: async () => ({ error: null, data: table === 'marketplace_items' ? parentExists ? { id: part.itemId } : null : { item_id: part.itemId, name: part.name, sku: part.sku, original_filename: part.originalFilename, gcode: changed ? 'changed' : part.gcode, dxf: null } }),
      }
      return query
    } }
    const repo = supabaseRepository(db as unknown as SupabaseClient)
    expect(await repo.itemExists('alice', part.itemId!)).toBe(true)
    expect(await repo.createComponent('alice', part)).toEqual({ created: true, id: part.id, itemId: 'next-item' })
    expect(inserts[0]).toEqual(expect.objectContaining({ owner_id: 'alice', item_id: part.itemId, id: part.id, gcode: part.gcode, width: part.width }))
    expect(filters.some(([key]) => key === 'owner_id')).toBe(false)
    duplicate = true
    expect(await repo.createComponent('alice', part)).toEqual({ created: false, id: part.id, itemId: 'next-item' })
    changed = true
    await expect(repo.createComponent('alice', part)).rejects.toMatchObject({ status: 409 })
    changed = false
    await expect(repo.createComponent('bob', { ...part, ownerId: 'bob' })).rejects.toMatchObject({ status: 409 })
    parentExists = false; inserts.length = 0
    await expect(repo.createComponent('alice', part)).rejects.toMatchObject({ status: 404 })
    await expect(repo.createComponent('bob', part)).rejects.toMatchObject({ status: 404 })
    expect(inserts).toEqual([])
  })
  it('creates items atomically and shares image reads/updates even with a service client', async () => {
    const calls: { method: string; args: unknown[] }[] = []
    let data: unknown = { id: 'item', name: 'Cabinet', sku: 'CAB', description: '' }
    let error: { code: string; message: string } | null = null
    const query: Record<string, (...args: unknown[]) => unknown> = {}
    for (const method of ['select', 'eq', 'insert', 'update']) query[method] = (...args) => { calls.push({ method, args }); return query }
    query.single = query.maybeSingle = async () => ({ data, error })
    const rpc = vi.fn(async () => ({ data: { current: { id: 'new-version' } }, error: null }))
    const repo = supabaseRepository({ from: () => query, rpc } as unknown as SupabaseClient)
    const input = { id: 'item', name: 'Cabinet', sku: 'CAB', description: '', image: testImage }
    await repo.createItem('alice', input, 'api_key:test')
    expect(calls.find(c => c.method === 'insert')?.args[0]).toEqual({ ...input, owner_id: 'alice', uploaded_by: 'api_key:test' })
    error = { code: '23505', message: 'Duplicate' }
    await expect(repo.createItem('bob', input, 'api_key:bob')).rejects.toMatchObject({ status: 409 })
    error = null; data = { image: testImage }; calls.length = 0
    expect(await repo.itemImage('alice', 'item')).toEqual(testImage)
    expect(calls).not.toContainEqual({ method: 'eq', args: ['owner_id', 'alice'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['id', 'item'] })
    calls.length = 0; data = { id: 'item', version_family_id: 'item', sku: 'CAB', name: 'Cabinet', description: 'Revision B', packing: {} }
    expect(await repo.updateItemDescription('alice', 'item', 'Revision B', 'Revision C')).toEqual({ id: 'new-version' })
    expect(calls).not.toContainEqual({ method: 'eq', args: ['owner_id', 'alice'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['id', 'item'] })
    expect(rpc).toHaveBeenCalledWith('update_item_version', expect.objectContaining({ p_action: 'metadata', p_payload: expect.objectContaining({ expected: expect.objectContaining({ description: 'Revision B' }), next: expect.objectContaining({ description: 'Revision C' }) }) }))
    calls.length = 0; data = null
    expect(await repo.updateItemImage('bob', 'item', null)).toBeUndefined()
    expect(calls).not.toContainEqual({ method: 'eq', args: ['owner_id', 'bob'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['id', 'item'] })
    expect(calls.some(c => c.method === 'update')).toBe(false)
  })
  it('looks up a hash, requires unrevoked/unexpired keys and derives owner from the record', async () => {
    const { query, repo } = fixture()
    const token = `cnc_${'0'.repeat(64)}`
    expect(await repo.authenticate(token)).toEqual({ ownerId: 'alice', actor: 'api_key:key-id' })
    expect(query.eq).toHaveBeenCalledWith('token_hash', await sha256(token))
    expect(query.is).toHaveBeenCalledWith('revoked_at', null)
    expect(query.gt).toHaveBeenCalledWith('expires_at', expect.any(String))
  })
  it('rejects malformed account keys without querying the database', async () => {
    const { db, repo } = fixture()
    expect(await repo.authenticate('cnc_invalid')).toBeUndefined()
    expect(db.from).not.toHaveBeenCalled()
  })
  it('requires server-verified user identity and matching MFA claims', async () => {
    const { db, repo } = fixture()
    expect(await repo.authenticate('user-jwt')).toEqual({ ownerId: 'alice', actor: 'user:alice' })
    expect(db.auth.getUser).toHaveBeenCalledWith('user-jwt')
    db.auth.getClaims.mockResolvedValue({ data: { claims: { sub: 'alice', aal: 'aal1' } }, error: null })
    expect(await repo.authenticate('user-jwt')).toBeUndefined()
    db.auth.getClaims.mockResolvedValue({ data: { claims: { sub: 'bob', aal: 'aal2' } }, error: null })
    expect(await repo.authenticate('user-jwt')).toBeUndefined()
  })
})
