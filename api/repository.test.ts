// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseRepository } from './repository'
import { sha256 } from '../src/jobs/generateJob'
import { testImage } from '../src/test/imageFixture'

function fixture() {
  const query = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), gt: vi.fn(), maybeSingle: vi.fn(async () => ({ data: { id: 'key-id', owner_id: 'alice' }, error: null })) }
  for (const method of ['select', 'eq', 'is', 'gt'] as const) query[method].mockReturnValue(query)
  const db = { from: vi.fn(() => query), auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'alice' } }, error: null })), getClaims: vi.fn(async () => ({ data: { claims: { sub: 'alice', aal: 'aal2' } }, error: null })) } }
  return { query, db, repo: supabaseRepository(db as unknown as SupabaseClient) }
}
describe('API credential verification', () => {
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
