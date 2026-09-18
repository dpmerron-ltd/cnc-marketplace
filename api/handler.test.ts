// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import { createApi, type Artifact, type JobRepository, type StoredJob } from './handler'
import { JobError } from '../src/jobs/generateJob'
import { testItem, testParts, testRequest } from '../src/test/jobFixtures'
import { defaultProgramSettings } from '../src/gcode/programSettings'
import { testImage } from '../src/test/imageFixture'
import { imageBytes } from '../src/models/ItemImage'

const font = new Uint8Array(await readFile(new URL('./assets/NotoSans-Regular.ttf', import.meta.url)))
function fixture() {
  const jobs = new Map<string, StoredJob & { owner: string; key: string; artifacts: Artifact[] }>()
  const repo: JobRepository = {
    authenticate: async token => ['alice', 'bob'].includes(token) ? { ownerId: token, actor: `api_key:${token}` } : undefined,
    allowRequest: async () => true,
    programSettings: vi.fn(async () => ({ ...defaultProgramSettings })),
    catalog: async owner => owner === 'alice' ? [testItem] : [],
    createItem: vi.fn(async (_owner, input) => ({ ...input, id: input.id ?? crypto.randomUUID() })),
    itemImage: vi.fn(async () => undefined),
    updateItemImage: vi.fn(async () => false),
    loadComponents: vi.fn(async owner => ({ items: owner === 'alice' ? [testItem] : [], parts: owner === 'alice' ? testParts : [] })),
    list: async () => [],
    get: async (owner, id) => jobs.get(id)?.owner === owner ? jobs.get(id) : undefined,
    findKey: async (owner, key) => [...jobs.values()].find(job => job.owner === owner && job.key === key),
    publish: async (owner, id, key, hash, manifest, files, artifacts) => {
      const previous = await repo.findKey(owner, key)
      if (previous) { if (previous.request_hash !== hash) throw new JobError('Conflict', 409); return previous }
      const job = { id, owner, key, request_hash: hash, manifest, files, artifacts, job_name: manifest.request.jobName, order_number: manifest.request.orderNumber, status: 'awaiting_review' as const, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status_history: [] }
      jobs.set(id, job)
      return job
    },
    transition: async (owner, id, expected, status) => {
      const job = jobs.get(id)!
      if (job.owner !== owner || job.status !== expected) throw new JobError('Status conflict', 409)
      job.status = status
      return job
    },
    artifact: async (owner, id, name) => jobs.get(id)?.owner === owner ? jobs.get(id)?.artifacts.find(file => file.name === name) : undefined,
  }
  const api = createApi(repo, font)
  const call = (path = '/jobs', method = 'GET', value?: unknown, token = 'alice', key = 'order-42') => api(new Request(`http://localhost/functions/v1/cnc-api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: value === undefined ? undefined : JSON.stringify(value) }))
  return { api, call, repo, jobs }
}

describe('jobs HTTP API', () => {
  it('creates private items with optional images and routes image reads, replacements and removal to the owner', async () => {
    const f = fixture()
    const input = { id: testItem.id, name: 'Cabinet', sku: 'CAB-1', image: testImage }
    const response = await f.call('/items', 'POST', input)
    expect(response.status).toBe(201)
    expect(f.repo.createItem).toHaveBeenCalledWith('alice', { ...input, description: '' }, 'api_key:alice')
    f.repo.itemImage = vi.fn(async owner => owner === 'alice' ? testImage : undefined)
    f.repo.updateItemImage = vi.fn(async owner => owner === 'alice')
    const path = `/items/${testItem.id}/image`
    const image = await f.call(path)
    expect(image.headers.get('Content-Type')).toBe('image/png')
    expect(image.headers.get('Cache-Control')).toBe('private, no-store')
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(imageBytes(testImage))
    expect((await f.call(path, 'GET', undefined, 'bob')).status).toBe(404)
    expect((await f.call(path, 'PATCH', { image: testImage }, 'bob')).status).toBe(404)
    expect((await f.call(path, 'PATCH', { image: testImage })).status).toBe(200)
    expect(f.repo.updateItemImage).toHaveBeenLastCalledWith('alice', testItem.id, testImage)
    expect((await f.call(path, 'PATCH', { image: null })).status).toBe(200)
    expect(f.repo.updateItemImage).toHaveBeenLastCalledWith('alice', testItem.id, null)
    expect((await f.call('/items', 'POST', { name: 'No photo', sku: 'NO-PHOTO' })).status).toBe(201)
  })
  it('rejects invalid image requests, oversized bodies, owner spoofing and unauthenticated uploads before writing', async () => {
    const f = fixture(), path = `/items/${testItem.id}/image`
    expect((await f.call('/items', 'POST', { name: 'Cabinet', sku: 'CAB', image: testImage }, 'invalid')).status).toBe(401)
    for (const value of [{ name: '', sku: 'CAB' }, { name: 'Cabinet', sku: 'CAB', ownerId: 'bob' }, { name: 'Cabinet', sku: 'CAB', image: { ...testImage, contentType: 'image/svg+xml' } }]) {
      expect((await f.call('/items', 'POST', value)).status).toBe(400)
    }
    for (const value of [{}, { image: { ...testImage, dataBase64: '<script>' } }, { image: null, ownerId: 'bob' }]) expect((await f.call(path, 'PATCH', value)).status).toBe(400)
    expect((await f.call(path, 'PATCH', { image: { ...testImage, dataBase64: 'x'.repeat(740000) } })).status).toBe(413)
    expect(f.repo.createItem).not.toHaveBeenCalled()
    expect(f.repo.updateItemImage).not.toHaveBeenCalled()
  })
  it('uses owner-specific programs, requires setup, and preserves old idempotent jobs after settings change', async () => {
    const f = fixture()
    f.repo.programSettings = vi.fn(async owner => owner === 'alice' ? { ...defaultProgramSettings, startGcode: '(Alice profile)\nG21 G90' } : undefined)
    const response = await f.call('/jobs', 'POST', testRequest)
    expect(response.status).toBe(201)
    const job = await response.json()
    expect(job.manifest.programSettings.startGcode).toContain('Alice profile')
    const nc = await f.call(`/jobs/${job.id}/artifacts/sheet-1.nc`)
    expect(await nc.text()).toContain('Alice profile')
    f.repo.programSettings = vi.fn(async () => undefined)
    expect((await f.call('/jobs', 'POST', testRequest)).status).toBe(200)
    expect(f.repo.programSettings).not.toHaveBeenCalled()
    expect((await f.call('/jobs', 'POST', testRequest, 'alice', 'new-order')).status).toBe(422)
    expect(f.jobs.size).toBe(1)
    expect((await f.call('/dxf-to-nc', 'POST', { dxf: 'test', thicknessMm: 18 }, 'bob')).status).toBe(422)
  })
  it('offers authenticated stateless DXF generation without touching account libraries or jobs', async () => {
    const f = fixture()
    const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'CIRCLE', '8', 'DRILL', '10', '20', '20', '20', '40', '3', '0', 'ENDSEC', '0', 'EOF', ''].join('\n')
    const value = { dxf, thicknessMm: 18 }
    expect((await f.call('/dxf-to-nc', 'POST', value, 'invalid')).status).toBe(401)
    const response = await f.call('/dxf-to-nc', 'POST', value, 'alice', '')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const result = await response.json()
    expect(result.reviewRequired).toBe(true)
    expect(result.gcode).toContain('G01 Z-9.2 F600\nG00 Z20')
    const replay = await f.call('/dxf-to-nc', 'POST', value, 'bob', '')
    expect((await replay.json()).gcode).toBe(result.gcode)
    expect(f.jobs.size).toBe(0)
    expect(f.repo.loadComponents).not.toHaveBeenCalled()
    f.repo.allowRequest = async () => false
    expect((await f.call('/dxf-to-nc', 'POST', value)).status).toBe(429)
  })
  it('keeps the larger DXF body allowance separate from job requests and validates transport', async () => {
    const f = fixture()
    const path = 'http://localhost/v1/dxf-to-nc'
    const request = (body: string, contentType = 'application/json') => f.api(new Request(path, { method: 'POST', headers: { Authorization: 'Bearer alice', 'Content-Type': contentType }, body }))
    expect((await request('{}', 'text/plain')).status).toBe(415)
    expect((await request('{')).status).toBe(400)
    expect((await request('x'.repeat(4 * 1024 * 1024 + 1))).status).toBe(413)
    expect((await f.call('/dxf-to-nc', 'POST', { dxf: 'x'.repeat(70000), thicknessMm: 18 })).status).toBe(422)
    expect((await f.call('/jobs', 'POST', { ...testRequest, notes: 'x'.repeat(70000) })).status).toBe(413)
    const invalid = await f.call('/dxf-to-nc', 'POST', { dxf: 'invalid', thicknessMm: 18 })
    const error = await invalid.json()
    expect(error.requestId).toBeTruthy()
    expect(error.details.length).toBeGreaterThan(0)
    expect(error.gcode).toBeUndefined()
  })
  it.each(['S12000 M03', ''])('applies Duet startup only from the authenticated profile in API DXF generation with spindle %s', async spindleStartGcode => {
    const f = fixture()
    const programs = { ...defaultProgramSettings, startGcode: 'M98 P"0:/macros/Probe"\nM400\nG00 Z5', spindleStartGcode }
    f.repo.programSettings = vi.fn(async owner => owner === 'alice' ? programs : { ...defaultProgramSettings })
    const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'CIRCLE', '8', 'DRILL', '10', '20', '20', '20', '40', '3', '0', 'ENDSEC', '0', 'EOF', ''].join('\n')
    const response = await f.call('/dxf-to-nc', 'POST', { dxf, thicknessMm: 18 })
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.programSettings).toEqual(programs)
    expect(result.gcode).toContain(programs.startGcode)
    expect(result.gcode.indexOf('M98')).toBeLessThan(result.gcode.indexOf('G00 Z20'))
    expect(result.gcode).toContain('G01 Z-9.2 F600\nG00 Z20')
    if (!spindleStartGcode) {
      expect(result.gcode).not.toMatch(/M03|S18000/)
      expect(result.settings.spindleRpm).toBe(0)
    }
    const other = await f.call('/dxf-to-nc', 'POST', { dxf, thicknessMm: 18 }, 'bob')
    expect((await other.json()).gcode).not.toContain('M98')
    expect(f.jobs.size).toBe(0)
    expect(f.repo.loadComponents).not.toHaveBeenCalled()
  })
  it('requires authentication and applies rate limits', async () => {
    const f = fixture()
    expect((await f.call('/items', 'GET', undefined, 'invalid')).status).toBe(401)
    f.repo.allowRequest = async () => false
    const response = await f.call('/jobs')
    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect((await f.api(new Request('http://localhost/v1/jobs', { method: 'OPTIONS' }))).status).toBe(204)
  })
  it('creates a complete review job, downloads exact-size labels and safely replays retries', async () => {
    const f = fixture()
    const response = await f.call('/jobs', 'POST', testRequest)
    expect(response.status).toBe(201)
    const job = await response.json()
    expect(job.status).toBe('awaiting_review')
    expect(job.request_hash).toBeUndefined()
    expect(job.files.map((file: { name: string }) => file.name)).toEqual(['sheet-plan.pdf', 'labels.pdf', 'manifest.json', 'sheet-1.nc', 'sheet-2.nc'])
    const labels = await f.call(`/jobs/${job.id}/artifacts/labels.pdf`)
    expect(labels.headers.get('content-type')).toBe('application/pdf')
    const pdf = await PDFDocument.load(await labels.arrayBuffer())
    expect(pdf.getPageCount()).toBe(4)
    for (const page of pdf.getPages()) { expect(page.getWidth() * 25.4 / 72).toBeCloseTo(50); expect(page.getHeight() * 25.4 / 72).toBeCloseTo(25) }
    const replay = await f.call('/jobs', 'POST', testRequest)
    expect(replay.status).toBe(200)
    expect((await replay.json()).id).toBe(job.id)
    expect(f.repo.loadComponents).toHaveBeenCalledTimes(1)
    expect(f.jobs.size).toBe(1)
    expect((await f.call('/jobs', 'POST', { ...testRequest, notes: 'changed' })).status).toBe(409)
    expect((await f.call(`/jobs/${job.id}`, 'GET', undefined, 'bob')).status).toBe(404)
    expect((await f.call(`/jobs/${job.id}/artifacts/labels.pdf`, 'GET', undefined, 'bob')).status).toBe(404)
    expect((await f.call(`/jobs/${job.id}`, 'PATCH', { status: 'ready', expectedStatus: 'awaiting_review' })).status).toBe(400)
    const approval = { status: 'ready', expectedStatus: 'awaiting_review', reviewConfirmed: true }
    expect((await f.call(`/jobs/${job.id}`, 'PATCH', approval)).status).toBe(200)
    expect((await f.call(`/jobs/${job.id}`, 'PATCH', approval)).status).toBe(409)
    expect((await f.call(`/jobs/${job.id}`, 'PATCH', { status: 'completed', expectedStatus: 'ready' })).status).toBe(409)
  })
  it('publishes nothing for foreign items, invalid payloads or failed persistence', async () => {
    const f = fixture()
    expect((await f.call('/jobs', 'POST', testRequest, 'bob')).status).toBe(422)
    expect((await f.call('/jobs', 'POST', { ...testRequest, ownerId: 'bob' })).status).toBe(400)
    expect((await f.call('/jobs', 'POST', testRequest, 'alice', '')).status).toBe(400)
    expect((await f.call('/jobs', 'POST', { ...testRequest, notes: 'x'.repeat(70000) })).status).toBe(413)
    expect(f.jobs.size).toBe(0)
  })
  it('handles concurrent retries as one stored job', async () => {
    const f = fixture()
    const responses = await Promise.all([f.call('/jobs', 'POST', testRequest), f.call('/jobs', 'POST', testRequest)])
    const payloads = await Promise.all(responses.map(response => response.json()))
    expect(payloads[0].id).toBe(payloads[1].id)
    expect(f.jobs.size).toBe(1)
  })
})
