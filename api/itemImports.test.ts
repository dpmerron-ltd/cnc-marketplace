// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { itemImportSchema, parseImportComponent, parseImportProfile } from './itemImports'
import { itemImportRepository } from './itemImportRepository'

const id = '10000000-0000-4000-8000-000000000001'
const gcode = 'G21 G90 G17\nG0 Z20\nG0 X0 Y0\nG1 Z-2 F600\nG1 X10 Y10 F3000\nG0 Z20\nM30'
const component = { id, sku: 'SIDE', name: 'Side', filename: 'side.nc', gcode, primaryProfile: '12-2mm' }
describe('complete revision import', () => {
  it('requires an explicit complete manifest and rejects duplicate or untrusted fields', () => {
    const input = { id, expectedVersionId: id, item: { name: 'Rack', sku: 'RACK', image: null }, componentIds: [id], documentIds: [] }
    expect(itemImportSchema.parse(input).item.description).toBe('')
    for (const changed of [{ ...input, componentIds: [id, id] }, { ...input, documentIds: [id, id] }, { ...input, owner: id }, { ...input, item: { name: 'Rack', sku: 'RACK' } }, { ...input, componentIds: [] }]) expect(itemImportSchema.safeParse(changed).success).toBe(false)
  })
  it('validates primary programs, derives geometry and forbids caller-supplied validation bypasses', () => {
    expect(parseImportComponent(component, id, id)).toMatchObject({ id, width: 10, height: 10, primaryProfile: '12-2mm', dxf: null })
    for (const changed of [{ ...component, width: 12 }, { ...component, materialVariants: {} }, { ...component, gcode: 'G0 X10' }, { ...component, gcode: gcode.replace('Z-2', 'Z-18') }]) expect(() => parseImportComponent(changed, id, id)).toThrow()
  })
  it('keeps unavailable profiles explicitly blocked and validates every available profile', () => {
    const input = { componentId: id, profileId: '6', gcode, warnings: [], errors: [] }
    expect(parseImportProfile(input, id, id).gcode).toBe(gcode)
    expect(parseImportProfile({ ...input, gcode: '', errors: ['Too many NC lines'] }, id, id).gcode).toBe('')
    for (const changed of [{ ...input, profileId: 'unknown' }, { ...input, errors: ['bad'] }, { ...input, gcode: '' }, { ...input, trusted: true }, { ...input, gcode: gcode.replace('Z-2', 'Z-12.2') }]) expect(() => parseImportProfile(changed, id, id)).toThrow()
  })
  it('passes authenticated ownership to each RPC and maps conflicts without exposing SQL', async () => {
    const rpc = vi.fn(async () => ({ data: { id }, error: null as null | { message: string } }))
    const repo = itemImportRepository({ rpc } as unknown as SupabaseClient)
    await repo.itemImport('alice', 'item', id)
    expect(rpc).toHaveBeenLastCalledWith('read_item_import', { p_actor: 'alice', p_item: 'item', p_id: id })
    await repo.stageItemImport('alice', 'item', id, 'profile', 'key', { gcode })
    expect(rpc).toHaveBeenLastCalledWith('stage_item_import', expect.objectContaining({ p_actor: 'alice', p_payload: { gcode } }))
    for (const [error, status] of [['IMPORT_NOT_FOUND', 404], ['IMPORT_FORBIDDEN', 403], ['IMPORT_CONFLICT', 409], ['IMPORT_INCOMPLETE', 422]] as const) {
      rpc.mockResolvedValueOnce({ data: { id }, error: { message: error } })
      await expect(repo.publishItemImport('alice', 'item', id)).rejects.toMatchObject({ status })
    }
  })
  it('checks import ownership and declared PDF IDs before touching storage', async () => {
    const upload = vi.fn(), storage = { from: vi.fn(() => ({ upload })) }
    const rpc = vi.fn(async () => ({ data: { documentIds: [] }, error: null }))
    const repo = itemImportRepository({ rpc, storage } as unknown as SupabaseClient)
    await expect(repo.stageImportDocument('alice', 'item', id, { id, kind: 'packing', filename: 'pack.pdf', pages: 1, bytes: new Uint8Array([1]) })).rejects.toMatchObject({ status: 422 })
    expect(storage.from).not.toHaveBeenCalled()
  })
})
