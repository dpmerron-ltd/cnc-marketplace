// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseRepository } from './repository'
import { sha256 } from '../src/jobs/generateJob'

function fixture() {
  const query = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), gt: vi.fn(), maybeSingle: vi.fn(async () => ({ data: { id: 'key-id', owner_id: 'alice' }, error: null })) }
  for (const method of ['select', 'eq', 'is', 'gt'] as const) query[method].mockReturnValue(query)
  const db = { from: vi.fn(() => query), auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'alice' } }, error: null })), getClaims: vi.fn(async () => ({ data: { claims: { sub: 'alice', aal: 'aal2' } }, error: null })) } }
  return { query, db, repo: supabaseRepository(db as unknown as SupabaseClient) }
}
describe('API credential verification', () => {
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
