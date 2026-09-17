import { z } from 'zod'
import { generateJob, JobError, parseJobRequest, sha256 } from '../src/jobs/generateJob'
import type { CuttingJob, JobFile, JobManifest, JobRequest, JobStatus, JobSummary } from '../src/jobs/types'
import type { MarketplaceItem } from '../src/models/Item'
import type { Part } from '../src/models/Part'
import { jobPdfs } from './pdf'
import { dxfBodyLimit, generateDxfNc } from './dxf'

export interface Artifact { name: string; contentType: string; dataBase64: string }
export interface Identity { ownerId: string; actor: string }
export interface StoredJob extends CuttingJob { request_hash: string }
export interface JobRepository {
  authenticate(token: string): Promise<Identity | undefined>
  allowRequest(owner: string): Promise<boolean>
  catalog(owner: string, limit: number, offset: number): Promise<unknown[]>
  loadComponents(owner: string, request: JobRequest): Promise<{ items: MarketplaceItem[]; parts: Part[] }>
  list(owner: string, limit: number, offset: number, status?: JobStatus): Promise<JobSummary[]>
  get(owner: string, id: string): Promise<StoredJob | undefined>
  findKey(owner: string, key: string): Promise<StoredJob | undefined>
  publish(owner: string, id: string, key: string, hash: string, manifest: JobManifest, files: JobFile[], artifacts: Artifact[], actor: string): Promise<StoredJob>
  transition(owner: string, id: string, expected: JobStatus, status: JobStatus, actor: string): Promise<StoredJob>
  artifact(owner: string, id: string, name: string): Promise<Artifact | undefined>
}
const statuses = ['awaiting_review', 'ready', 'cutting', 'completed', 'cancelled'] as const
const transitions: Record<JobStatus, JobStatus[]> = { awaiting_review: ['ready', 'cancelled'], ready: ['cutting', 'cancelled'], cutting: ['completed', 'cancelled'], completed: [], cancelled: [] }
const statusSchema = z.strictObject({ status: z.enum(statuses), expectedStatus: z.enum(statuses), reviewConfirmed: z.boolean().optional() })
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, idempotency-key, x-client-info', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
function json(body: unknown, status = 200, extra: Record<string, string> = {}) { return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', ...extra } }) }
export function encodeBase64(bytes: Uint8Array) { let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(binary) }
export function decodeBase64(value: string) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)) }
function publicJob(job: StoredJob): CuttingJob {
  return { id: job.id, job_name: job.job_name, order_number: job.order_number, status: job.status, created_at: job.created_at, updated_at: job.updated_at, manifest: job.manifest, files: job.files, status_history: job.status_history }
}
async function body(request: Request, maxBytes = 65536): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new JobError('Use Content-Type: application/json.', 415)
  const reader = request.body?.getReader()
  if (!reader) throw new JobError('A JSON request body is required.', 400)
  let total = 0, value = ''
  const decoder = new TextDecoder()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    total += chunk.value.length
    if (total > maxBytes) { await reader.cancel(); throw new JobError(`Request body exceeds ${maxBytes / 1024} KiB.`, 413) }
    value += decoder.decode(chunk.value, { stream: true })
  }
  try { return JSON.parse(value + decoder.decode()) } catch { throw new JobError('Invalid JSON.', 400) }
}

export function createApi(repository: JobRepository, fontBytes: Uint8Array) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    const requestId = crypto.randomUUID()
    try {
      const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]
      const identity = token && await repository.authenticate(token)
      if (!identity) throw new JobError('A valid account API key or MFA-verified session is required.', 401)
      const owner = identity.ownerId
      if (!await repository.allowRequest(owner)) return json({ error: 'Account rate limit exceeded. Retry in 60 seconds.', requestId }, 429, { 'Retry-After': '60' })
      const url = new URL(request.url)
      const path = url.pathname.replace(/^.*?\/cnc-api(?=\/|$)/, '')
      if (path === '/v1/dxf-to-nc' && request.method === 'POST') return json(await generateDxfNc(await body(request, dxfBodyLimit)))
      const limit = Number(url.searchParams.get('limit') ?? 25), offset = Number(url.searchParams.get('offset') ?? 0)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) throw new JobError('Invalid pagination: limit 1-100, offset 0-100000.', 400)
      if (path === '/v1/items' && request.method === 'GET') return json({ items: await repository.catalog(owner, limit, offset), limit, offset })
      if (path === '/v1/jobs' && request.method === 'GET') {
        const status = url.searchParams.get('status') as JobStatus | null
        if (status && !statuses.includes(status)) throw new JobError('Unknown job status.', 400)
        return json({ jobs: await repository.list(owner, limit, offset, status ?? undefined), limit, offset })
      }
      if (path === '/v1/jobs' && request.method === 'POST') {
        const key = request.headers.get('idempotency-key')
        if (!key || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(key)) throw new JobError('Idempotency-Key is required (1-128 letters, digits, dots, colons, underscores or hyphens).', 400)
        const input = parseJobRequest(await body(request))
        const hash = await sha256(JSON.stringify(input))
        const previous = await repository.findKey(owner, key)
        if (previous) {
          if (previous.request_hash !== hash) throw new JobError('Idempotency-Key was already used with a different request.', 409)
          return json(publicJob(previous), 200, { 'Idempotent-Replayed': 'true' })
        }
        const catalog = await repository.loadComponents(owner, input)
        const job = await generateJob(input, catalog.items, catalog.parts)
        const id = crypto.randomUUID()
        const pdfs = await jobPdfs(job, id, fontBytes)
        const raw = [
          { name: 'sheet-plan.pdf', contentType: 'application/pdf', bytes: pdfs.plan },
          { name: 'labels.pdf', contentType: 'application/pdf', bytes: pdfs.labels },
          { name: 'manifest.json', contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify({ jobId: id, ...job.manifest }, null, 2)) },
          ...job.exported.map(file => ({ name: `sheet-${file.sheetIndex + 1}.nc`, contentType: 'text/plain', bytes: new TextEncoder().encode(file.gcode) })),
        ]
        if (raw.reduce((sum, file) => sum + file.bytes.length, 0) > 12000000) throw new JobError('Generated job exceeds 12 MB. Split the order into smaller jobs.')
        const files = await Promise.all(raw.map(async file => ({ name: file.name, contentType: file.contentType, bytes: file.bytes.length, sha256: await sha256(file.bytes) })))
        const saved = await repository.publish(owner, id, key, hash, job.manifest, files, raw.map(file => ({ name: file.name, contentType: file.contentType, dataBase64: encodeBase64(file.bytes) })), identity.actor)
        return json(publicJob(saved), saved.id === id ? 201 : 200, { Location: `${url.pathname}/${saved.id}` })
      }
      const match = path.match(/^\/v1\/jobs\/([0-9a-f-]{36})(?:\/artifacts\/([a-z0-9.-]+))?$/i)
      if (match) {
        const [, id, name] = match
        if (!z.uuid().safeParse(id).success) throw new JobError('Invalid job ID.', 400)
        const job = await repository.get(owner, id)
        if (!job) throw new JobError('Job not found.', 404)
        if (name && request.method === 'GET') {
          if (!job.files.some(file => file.name === name)) throw new JobError('Artifact not found.', 404)
          const file = await repository.artifact(owner, id, name)
          if (!file) throw new JobError('Artifact not found.', 404)
          return new Response(decodeBase64(file.dataBase64), { headers: { ...headers, 'Content-Type': file.contentType, 'Content-Disposition': `attachment; filename="${file.name}"` } })
        }
        if (!name && request.method === 'GET') return json(publicJob(job))
        if (!name && request.method === 'PATCH') {
          const parsed = statusSchema.safeParse(await body(request))
          if (!parsed.success) throw new JobError('Supply status, expectedStatus and optional reviewConfirmed.', 400)
          const update = parsed.data
          if (!transitions[update.expectedStatus].includes(update.status)) throw new JobError('Invalid queue status transition.', 409)
          if (update.status === 'ready' && update.reviewConfirmed !== true) throw new JobError('Operator review must be explicitly confirmed before a job is ready.', 400)
          return json(publicJob(await repository.transition(owner, id, update.expectedStatus, update.status, identity.actor)))
        }
      }
      return json({ error: 'Route or method not found.', requestId }, 404)
    } catch (error) {
      if (error instanceof JobError) return json({ error: error.message, details: error.details, requestId }, error.status)
      console.error('CNC API request failed', requestId, error instanceof Error ? error.name : 'unknown')
      return json({ error: 'The request could not be completed. Retry using the same Idempotency-Key.', requestId }, 500)
    }
  }
}
