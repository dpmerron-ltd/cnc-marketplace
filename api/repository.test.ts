// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseRepository } from './repository'
import { sha256 } from '../src/jobs/generateJob'
import { testImage } from '../src/test/imageFixture'
import { testItem, testParts } from '../src/test/jobFixtures'
import { materialProfiles, materialVariantsSchema } from '../src/cam/materialProfiles'

function fixture() {
  const query = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), gt: vi.fn(), maybeSingle: vi.fn(async () => ({ data: { id: 'key-id', owner_id: 'alice' }, error: null })) }
  for (const method of ['select', 'eq', 'is', 'gt'] as const) query[method].mockReturnValue(query)
  const db = { from: vi.fn(() => query), auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'alice' } }, error: null })), getClaims: vi.fn(async () => ({ data: { claims: { sub: 'alice', aal: 'aal2' } }, error: null })) } }
  return { query, db, repo: supabaseRepository(db as unknown as SupabaseClient) }
}
describe('API credential verification', () => {
  it('returns exact source and revision only through owner, item and component filters', async () => {
    const row = { id: 'part', item_id: 'item', name: 'Panel', sku: 'P1', original_filename: 'panel.nc', gcode: testParts[0].gcode, dxf: 'original DXF', material_variants: null }
    let data: typeof row | null = row
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data, error: null })) }
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query)
    const repo = supabaseRepository({ from: () => query } as unknown as SupabaseClient)
    expect(await repo.componentSource('alice', 'item', 'part')).toEqual({ id: 'part', itemId: 'item', name: 'Panel', sku: 'P1', filename: 'panel.nc', gcode: row.gcode, dxf: row.dxf, materialVariants: null, sha256: await sha256(row.gcode) })
    for (const pair of [['owner_id', 'alice'], ['item_id', 'item'], ['id', 'part']]) expect(query.eq).toHaveBeenCalledWith(...pair)
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
  it('validates replacements before an owner-scoped compare-and-swap, preserving source and identity', async () => {
    const id = '20000000-0000-4000-8000-000000000001'
    const row = { id, name: 'Side', sku: 'SIDE', original_filename: 'side.nc', dxf: 'original DXF' }
    let found = true
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: found ? row : null, error: null })) }
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query)
    const rpc = vi.fn(async (_name: string, _args: unknown): Promise<{ data: boolean | null; error: { message: string } | null }> => ({ data: true, error: null }))
    const repo = supabaseRepository({ from: () => query, rpc } as unknown as SupabaseClient)
    const gcode = testParts[0].gcode
    const materialVariants = materialVariantsSchema.parse({ version: 1, primaryProfile: '18', profiles: Object.fromEntries(materialProfiles.map(p => [p.id, { gcode, errors: [], warnings: [] }])) })
    const input = { gcode, materialVariants, expectedSha256: 'a'.repeat(64), expectedMaterialVariants: null }
    const result = await repo.replaceComponent('alice', testItem.id, id, input)
    expect(result.part).toMatchObject({ id, name: row.name, sku: row.sku, dxf: row.dxf, originalFilename: row.original_filename, ownerId: 'alice', itemId: testItem.id })
    for (const pair of [['owner_id', 'alice'], ['item_id', testItem.id], ['id', id]]) expect(query.eq).toHaveBeenCalledWith(...pair)
    expect(rpc).toHaveBeenCalledWith('replace_cnc_component_gcode', expect.objectContaining({ p_owner: 'alice', p_item: testItem.id, p_id: id, p_expected_sha: input.expectedSha256, p_expected_variants: null, p_expected_dxf: row.dxf, p_gcode: gcode, p_variants: materialVariants, p_width: result.part.width }))
    rpc.mockClear()
    const corrected = await repo.replaceComponent('alice', testItem.id, id, { ...input, dxf: 'corrected source DXF', expectedDxf: row.dxf })
    expect(corrected.part.dxf).toBe('corrected source DXF')
    expect(rpc).toHaveBeenCalledWith('replace_cnc_component_source', expect.objectContaining({ p_owner: 'alice', p_expected_dxf: row.dxf, p_dxf: 'corrected source DXF', p_gcode: gcode, p_variants: materialVariants }))
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
  it('inserts only owned components and only replays identical owned uploads', async () => {
    const part = { ...testParts[0], ownerId: 'alice', itemId: testItem.id }
    let parentExists = true, duplicate = false, storedOwner = 'alice', changed = false
    const inserts: unknown[] = [], filters: [string, unknown][] = []
    const db = { from(table: string) {
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query },
        insert: async (value: unknown) => { inserts.push(value); return { data: null, error: duplicate ? { code: '23505', message: 'Duplicate' } : null } },
        maybeSingle: async () => ({ error: null, data: table === 'marketplace_items' ? parentExists ? { id: part.itemId } : null : storedOwner === 'alice' ? { item_id: part.itemId, name: part.name, sku: part.sku, original_filename: part.originalFilename, gcode: changed ? 'changed' : part.gcode, dxf: null } : null }),
      }
      return query
    } }
    const repo = supabaseRepository(db as unknown as SupabaseClient)
    expect(await repo.ownsItem('alice', part.itemId!)).toBe(true)
    expect(await repo.createComponent('alice', part)).toEqual({ created: true })
    expect(inserts[0]).toEqual(expect.objectContaining({ owner_id: 'alice', item_id: part.itemId, id: part.id, gcode: part.gcode, width: part.width }))
    expect(filters).toContainEqual(['owner_id', 'alice'])
    duplicate = true
    expect(await repo.createComponent('alice', part)).toEqual({ created: false })
    changed = true
    await expect(repo.createComponent('alice', part)).rejects.toMatchObject({ status: 409 })
    changed = false; storedOwner = 'bob'
    await expect(repo.createComponent('alice', part)).rejects.toMatchObject({ status: 409 })
    parentExists = false; inserts.length = 0
    await expect(repo.createComponent('alice', part)).rejects.toMatchObject({ status: 404 })
    await expect(repo.createComponent('bob', part)).rejects.toMatchObject({ status: 404 })
    expect(inserts).toEqual([])
  })
  it('creates items atomically and scopes image reads/updates by owner even with a service client', async () => {
    const calls: { method: string; args: unknown[] }[] = []
    let data: unknown = { id: 'item', name: 'Cabinet', sku: 'CAB', description: '' }
    let error: { code: string; message: string } | null = null
    const query: Record<string, (...args: unknown[]) => unknown> = {}
    for (const method of ['select', 'eq', 'insert', 'update']) query[method] = (...args) => { calls.push({ method, args }); return query }
    query.single = query.maybeSingle = async () => ({ data, error })
    const repo = supabaseRepository({ from: () => query } as unknown as SupabaseClient)
    const input = { id: 'item', name: 'Cabinet', sku: 'CAB', description: '', image: testImage }
    await repo.createItem('alice', input, 'api_key:test')
    expect(calls.find(c => c.method === 'insert')?.args[0]).toEqual({ ...input, owner_id: 'alice', uploaded_by: 'api_key:test' })
    error = { code: '23505', message: 'Duplicate' }
    await expect(repo.createItem('bob', input, 'api_key:bob')).rejects.toMatchObject({ status: 409 })
    error = null; data = { image: testImage }; calls.length = 0
    expect(await repo.itemImage('alice', 'item')).toEqual(testImage)
    expect(calls).toContainEqual({ method: 'eq', args: ['owner_id', 'alice'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['id', 'item'] })
    calls.length = 0; data = { id: 'item' }
    expect(await repo.updateItemDescription('alice', 'item', 'Revision B', 'Revision C')).toBe(true)
    expect(calls).toContainEqual({ method: 'eq', args: ['owner_id', 'alice'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['id', 'item'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['description', 'Revision B'] })
    expect(calls.find(c => c.method === 'update')?.args[0]).toEqual({ description: 'Revision C', updated_at: expect.any(String) })
    calls.length = 0; data = null
    expect(await repo.updateItemImage('bob', 'item', null)).toBe(false)
    expect(calls).toContainEqual({ method: 'eq', args: ['owner_id', 'bob'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['id', 'item'] })
    expect(calls.find(c => c.method === 'update')?.args[0]).toEqual({ image: null, updated_at: expect.any(String) })
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
