import { beforeEach, describe, expect, it, vi } from 'vitest'
import { changeMachineRecutStatus, listMachineRecuts, listRunRecuts, queueMachineRecut } from './machineRecutsStore'
import type { MachineRecut } from '../machine/recuts'

const mock = vi.hoisted(() => ({
  owner: 'alice',
  results: [] as Array<{ data: unknown; error: null | { code?: string; message: string } }>,
  queries: [] as Array<{ table: string; filters: Array<[string, unknown]>; insert?: unknown; update?: unknown; range?: [number, number]; signal?: AbortSignal }>,
}))
vi.mock('./supabaseClient', () => ({ supabase: {
  auth: { getUser: async () => ({ data: { user: { id: mock.owner } }, error: null }) },
  from: (table: string) => {
    const query: typeof mock.queries[number] = { table, filters: [] }; mock.queries.push(query)
    const builder = {
      select: () => builder,
      eq: (field: string, value: unknown) => { query.filters.push([field, value]); return builder },
      insert: (value: unknown) => { query.insert = value; return builder },
      update: (value: unknown) => { query.update = value; return builder },
      order: () => builder,
      range: (start: number, end: number) => { query.range = [start, end]; return builder },
      single: async () => mock.results.shift(),
      abortSignal: async (signal: AbortSignal) => { query.signal = signal; return mock.results.shift() },
    }
    return builder
  },
} }))

const entry = { id: 'recut-1', owner_id: 'alice', source_run_id: 'export-1', sheet_index: 1, part_number: 'P002', status: 'queued' } as MachineRecut
describe('machine re-cut storage', () => {
  beforeEach(() => { mock.owner = 'alice'; mock.results = []; mock.queries = [] })

  it('requests only an exact source part and reuses the queued row after a duplicate/retry', async () => {
    mock.results.push({ data: entry, error: null })
    expect(await queueMachineRecut('alice', 'export-1', 1, 'P002')).toEqual(entry)
    expect(mock.queries[0].insert).toEqual({ owner_id: 'alice', source_run_id: 'export-1', sheet_index: 1, part_number: 'P002' })
    mock.results.push({ data: null, error: { code: '23505', message: 'Duplicate pending part' } }, { data: entry, error: null })
    expect(await queueMachineRecut('alice', 'export-1', 1, 'P002')).toEqual(entry)
    expect(mock.queries[2].filters).toEqual([['owner_id', 'alice'], ['source_run_id', 'export-1'], ['sheet_index', 1], ['part_number', 'P002'], ['status', 'queued']])
  })

  it('scopes queue and source-run reads to the signed-in owner with cancellation and pagination', async () => {
    const signal = new AbortController().signal
    mock.results.push({ data: [entry], error: null }, { data: [entry], error: null })
    expect(await listMachineRecuts('alice', 25, 'queued', signal)).toEqual([entry])
    expect(mock.queries[0]).toMatchObject({ filters: [['owner_id', 'alice'], ['status', 'queued']], range: [25, 49], signal })
    expect(await listRunRecuts('alice', 'export-1', signal)).toEqual([entry])
    expect(mock.queries[1]).toMatchObject({ filters: [['owner_id', 'alice'], ['source_run_id', 'export-1'], ['status', 'queued']], signal })
  })

  it('rejects account changes before reading or writing and checks status when completing a request', async () => {
    mock.owner = 'bob'
    await expect(queueMachineRecut('alice', 'export-1', 1, 'P002')).rejects.toThrow('account changed')
    await expect(listMachineRecuts('alice', 0, 'queued', new AbortController().signal)).rejects.toThrow('account changed')
    await expect(changeMachineRecutStatus('alice', entry, 'completed')).rejects.toThrow('account changed')
    expect(mock.queries).toEqual([])
    mock.owner = 'alice'; mock.results.push({ data: { id: entry.id }, error: null })
    await changeMachineRecutStatus('alice', entry, 'completed')
    expect(mock.queries[0]).toMatchObject({ update: { status: 'completed' }, filters: [['owner_id', 'alice'], ['id', entry.id], ['status', 'queued']] })
  })

  it('surfaces save, read, and conflict errors instead of reporting success', async () => {
    mock.results.push({ data: null, error: { message: 'Offline' } })
    await expect(queueMachineRecut('alice', 'export-1', 1, 'P002')).rejects.toThrow('Offline')
    expect(mock.queries).toHaveLength(1)
    mock.results.push({ data: null, error: { message: 'Read failed' } })
    await expect(listMachineRecuts('alice', 0, '', new AbortController().signal)).rejects.toThrow('Read failed')
    mock.results.push({ data: null, error: null })
    await expect(changeMachineRecutStatus('alice', entry, 'cancelled')).rejects.toThrow('another device')
  })
})
