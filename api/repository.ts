import type { SupabaseClient } from '@supabase/supabase-js'
import { createPartFromGCode } from '../src/gcode/importPart'
import { JobError, sha256 } from '../src/jobs/generateJob'
import type { JobRequest, JobStatus, JobManifest, JobFile } from '../src/jobs/types'
import type { Artifact, JobRepository, StoredJob } from './handler'
import { normalizePrograms } from '../src/gcode/programSettings'

function checked<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) {
    if (/IDEMPOTENCY_CONFLICT/.test(result.error.message)) throw new JobError('Idempotency-Key was already used with a different request.', 409)
    if (/STATUS_CONFLICT|INVALID_TRANSITION/.test(result.error.message)) throw new JobError('Job status changed or the requested transition is invalid. Refresh and retry.', 409)
    throw new Error('Database operation failed.')
  }
  return result.data
}

export function supabaseRepository(db: SupabaseClient): JobRepository {
  const get = async (owner: string, id: string) => checked(await db.from('cnc_jobs').select('*').eq('owner_id', owner).eq('id', id).maybeSingle()) as StoredJob | undefined
  return {
    async authenticate(token) {
      if (token.length > 4096) return undefined
      if (/^cnc_[0-9a-f]{64}$/.test(token)) {
        const key = checked(await db.from('cnc_api_keys').select('id,owner_id').eq('token_hash', await sha256(token)).is('revoked_at', null).gt('expires_at', new Date().toISOString()).maybeSingle())
        return key ? { ownerId: key.owner_id, actor: `api_key:${key.id}` } : undefined
      }
      if (token.startsWith('cnc_')) return undefined
      const user = await db.auth.getUser(token)
      if (user.error || !user.data.user) return undefined
      const claims = await db.auth.getClaims(token)
      if (claims.error || claims.data?.claims.aal !== 'aal2' || claims.data.claims.sub !== user.data.user.id) return undefined
      return { ownerId: user.data.user.id, actor: `user:${user.data.user.id}` }
    },
    async allowRequest(owner) { return checked(await db.rpc('allow_cnc_api_request', { p_owner: owner })) === true },
    async programSettings(owner) {
      const row = checked(await db.from('user_program_settings').select('start_gcode,spindle_start_gcode,end_gcode').eq('owner_id', owner).maybeSingle())
      return row ? normalizePrograms({ startGcode: row.start_gcode, spindleStartGcode: row.spindle_start_gcode, endGcode: row.end_gcode }) : undefined
    },
    async catalog(owner, limit, offset) {
      return checked(await db.from('marketplace_items').select('id,sku,name,description,cnc_components(id,sku,name,width,height)').eq('owner_id', owner).eq('cnc_components.owner_id', owner).order('id').range(offset, offset + limit - 1)) ?? []
    },
    async loadComponents(owner, request: JobRequest) {
      const ids = request.items.flatMap(item => item.itemId ? [item.itemId] : [])
      const skus = request.items.flatMap(item => item.sku ? [item.sku] : [])
      const select = 'id,owner_id,sku,name,description,created_at,updated_at'
      const byId = ids.length ? checked(await db.from('marketplace_items').select(select).eq('owner_id', owner).in('id', ids).limit(21)) ?? [] : []
      const bySku = skus.length ? checked(await db.from('marketplace_items').select(select).eq('owner_id', owner).in('sku', skus).limit(21)) ?? [] : []
      const rows = [...new Map([...byId, ...bySku].map(item => [item.id, item])).values()]
      if (rows.length > 20) throw new JobError('Too many matching items or ambiguous SKUs.')
      const items = rows.map(row => ({ id: row.id, ownerId: row.owner_id, sku: row.sku, name: row.name, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at }))
      const components = rows.length ? checked(await db.from('cnc_components').select('id,owner_id,item_id,sku,name,original_filename,gcode,date_imported').eq('owner_id', owner).in('item_id', rows.map(item => item.id)).order('id').limit(21)) ?? [] : []
      if (components.length > 20 || components.reduce((sum, row) => sum + row.gcode.length, 0) > 2000000) throw new JobError('Selected component library exceeds the per-job limit. Split the order into smaller jobs.')
      if (components.reduce((sum, row) => sum + row.gcode.split('\n').length, 0) > 5000) throw new JobError('Selected source programs exceed 5,000 lines. Split the order into smaller jobs.')
      const parts = components.map(row => ({ ...createPartFromGCode(row.original_filename, row.gcode, undefined, row.item_id), id: row.id, ownerId: row.owner_id, name: row.name, sku: row.sku, dateImported: row.date_imported }))
      return { items, parts }
    },
    async list(owner, limit, offset, status?: JobStatus) {
      let query = db.from('cnc_jobs').select('id,job_name,order_number,status,part_count,sheet_count,created_at,updated_at,files,status_history').eq('owner_id', owner)
      if (status) query = query.eq('status', status)
      return checked(await query.order('created_at', { ascending: false }).order('id').range(offset, offset + limit - 1)) ?? []
    },
    get,
    async findKey(owner, key) { return checked(await db.from('cnc_jobs').select('*').eq('owner_id', owner).eq('idempotency_key', key).maybeSingle()) as StoredJob | undefined },
    async publish(owner: string, id: string, key: string, hash: string, manifest: JobManifest, files: JobFile[], artifacts: Artifact[], actor: string) {
      return checked(await db.rpc('publish_cnc_job', { p_owner: owner, p_id: id, p_key: key, p_hash: hash, p_manifest: manifest, p_files: files, p_artifacts: artifacts, p_actor: actor })) as StoredJob
    },
    async transition(owner, id, expected, status, actor) {
      return checked(await db.rpc('transition_cnc_job', { p_owner: owner, p_id: id, p_expected: expected, p_status: status, p_actor: actor })) as StoredJob
    },
    async artifact(owner, id, name) {
      const file = checked(await db.from('cnc_job_artifacts').select('name,content_type,data_base64').eq('owner_id', owner).eq('job_id', id).eq('name', name).maybeSingle())
      return file ? { name: file.name, contentType: file.content_type, dataBase64: file.data_base64 } : undefined
    },
  }
}
