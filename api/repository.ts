import type { SupabaseClient } from '@supabase/supabase-js'
import { createPartFromGCode } from '../src/gcode/importPart'
import { JobError, sha256 } from '../src/jobs/generateJob'
import type { JobRequest, JobStatus, JobManifest, JobFile } from '../src/jobs/types'
import type { Artifact, JobRepository, StoredJob } from './handler'
import { normalizePrograms } from '../src/gcode/programSettings'
import { itemImageSchema } from '../src/models/ItemImage'
import { materialVariantsSchema } from '../src/cam/materialProfiles'
import { parseComponent } from './components'
import { boxStockSchema } from '../src/packing/boxStock'
import { documentRepository } from './documentRepository'
import { itemImportRepository } from './itemImportRepository'
import type { VersionUpdateResult } from '../src/storage/catalogueChanges'

function checked<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) {
    if (/ITEM_VERSION_FORBIDDEN/.test(result.error.message)) throw new JobError('A verified account is required.', 403)
    if (/ITEM_VERSION_NOT_FOUND/.test(result.error.message)) throw new JobError('Item version not found.', 404)
    if (/ITEM_VERSION_INVALID/.test(result.error.message)) throw new JobError('The item update is invalid. Check the required fields and uploaded files.', 422)
    if (/ITEM_VERSION_READ_ONLY/.test(result.error.message)) throw new JobError('Use the versioned catalogue update endpoints; previous versions cannot be overwritten.', 409)
    if (/ITEM_VERSION_CONFLICT/.test(result.error.message)) throw new JobError('The item changed. Reload its current version before retrying.', 409)
    if (/ORDER_FORBIDDEN/.test(result.error.message)) throw new JobError('Only the order administrator can manage assignments.', 403)
    if (/ORDER_REVISION_CONFLICT/.test(result.error.message)) throw new JobError('Assignment or payment changed. Reload the order before saving again.', 409)
    if (/ORDER_USER_NOT_FOUND/.test(result.error.message)) throw new JobError('Selected user no longer exists.', 404)
    if (/ORDER_INVALID/.test(result.error.message)) throw new JobError('Invalid order assignment.', 400)
    if (/BOX_REVISION_CONFLICT/.test(result.error.message)) throw new JobError('Box stock changed. Refresh before updating the count.', 409)
    if (/BOX_NOT_FOUND/.test(result.error.message)) throw new JobError('Box not found.', 404)
    if (/COMPONENT_REVISION_CONFLICT/.test(result.error.message)) throw new JobError('Component changed since the expected revision. Nothing was replaced.', 409)
    if (/COMPONENT_NOT_FOUND/.test(result.error.message)) throw new JobError('Component not found.', 404)
    if (/IDEMPOTENCY_CONFLICT/.test(result.error.message)) throw new JobError('Idempotency-Key was already used with a different request.', 409)
    if (/STATUS_CONFLICT|INVALID_TRANSITION/.test(result.error.message)) throw new JobError('Job status changed or the requested transition is invalid. Refresh and retry.', 409)
    throw new Error('Database operation failed.')
  }
  return result.data
}

export function supabaseRepository(db: SupabaseClient): JobRepository {
  const get = async (owner: string, id: string) => checked(await db.from('cnc_jobs').select('*').eq('owner_id', owner).eq('id', id).maybeSingle()) as StoredJob | undefined
  const revise = async (owner: string, item: string, action: string, payload: unknown) => checked(await db.rpc('update_item_version', { p_actor: owner, p_item: item, p_action: action, p_payload: payload })) as VersionUpdateResult
  const currentItem = async (id: string) => {
    const item = checked(await db.from('marketplace_items').select('version_family_id').eq('id', id).maybeSingle())
    return item ? checked(await db.from('marketplace_items').select('id,sku,name,description,packing,image').eq('version_family_id', item.version_family_id).eq('version_default', true).maybeSingle()) : undefined
  }
  return {
    ...documentRepository(db),
    ...itemImportRepository(db),
    async orderAdmin() {
      return checked(await db.from('cnc_order_admin').select('user_id').eq('singleton', true).maybeSingle())?.user_id ?? null
    },
    async orderUsers(owner, offset) {
      return checked(await db.rpc('cnc_order_users', { p_actor: owner, p_offset: offset })) ?? []
    },
    async orderAssignments(owner, shop, ids, offset = 0, search = '') {
      return checked(await db.rpc('read_cnc_order_assignments', { p_actor: owner, p_shop: shop, p_ids: ids ?? null, p_offset: offset, p_search: search })) ?? []
    },
    async assignOrder(owner, shop, id, name, input) {
      checked(await db.rpc('assign_cnc_order', { p_actor: owner, p_shop: shop, p_order_id: id, p_order_name: name, p_assignee: input.assigneeId, p_payment_pence: input.paymentPence, p_expected_version: input.expectedVersion }))
    },
    async boxes(_owner) {
      return boxStockSchema.array().parse(checked(await db.from('box_stock').select('id,name,length_mm,width_mm,height_mm,quantity,details,version,updated_at').order('length_mm').order('id')) ?? [])
    },
    async createBox(owner, input) {
      const response = await db.from('box_stock').insert({ ...input, updated_by: owner }).select('id,name,length_mm,width_mm,height_mm,quantity,details,version,updated_at').single()
      if (response.error?.code === '23505') throw new JobError('This box ID or size already exists. Refresh box stock before retrying.', 409)
      return boxStockSchema.parse(checked(response))
    },
    async countBox(owner, id, input) {
      return boxStockSchema.parse(checked(await db.rpc('count_cnc_boxes', { p_actor: owner, p_id: id, p_quantity: input.quantity, p_expected_version: input.expectedVersion })))
    },
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
    async catalog(_owner, limit, offset) {
      return checked(await db.from('marketplace_items').select('id,sku,name,description,version_family_id,version_number,version_status,version_default,published_at,imageContentType:image->>contentType,cnc_components(id,sku,name,width,height)').eq('version_default', true).order('id').range(offset, offset + limit - 1)) ?? []
    },
    async itemVersions(_owner, id, limit, offset) {
      const item = checked(await db.from('marketplace_items').select('version_family_id').eq('id', id).maybeSingle())
      if (!item) throw new JobError('Item not found.', 404)
      return checked(await db.from('marketplace_items').select('id,sku,name,description,version_family_id,version_number,version_status,version_default,published_at,cnc_components(id,sku,name,width,height)').eq('version_family_id', item.version_family_id).order('version_number', { ascending: false }).range(offset, offset + limit - 1)) ?? []
    },
    async createItem(owner, input, actor) {
      const result = await db.from('marketplace_items').insert({
        id: input.id ?? crypto.randomUUID(), owner_id: owner, uploaded_by: actor,
        name: input.name, sku: input.sku, description: input.description, image: input.image ?? null,
      }).select('id,name,sku,description,version_family_id,version_number,version_status,version_default').single()
      if (result.error?.code === '23505') throw new JobError('Item ID already exists. Use GET /v1/items to check your catalogue before retrying.', 409)
      const row = checked(result)
      if (!row) throw new Error('Item was not created.')
      return row
    },
    async updateItemDescription(owner, id, expected, description) {
      const item = await currentItem(id)
      if (!item || item.description !== expected) return undefined
      const metadata = { sku: item.sku, name: item.name, description: item.description, packing: item.packing ?? {} }
      const result = await revise(owner, id, 'metadata', { expected: metadata, next: { ...metadata, description } })
      return { id: result.current.id }
    },
    async itemImage(_owner, id) {
      const row = checked(await db.from('marketplace_items').select('image').eq('id', id).maybeSingle())
      const parsed = itemImageSchema.safeParse(row?.image)
      return parsed.success ? parsed.data : undefined
    },
    async updateItemImage(owner, id, image) {
      const item = await currentItem(id)
      if (!item) return undefined
      const result = await revise(owner, id, 'image', { image, expected: item.image })
      return { id: result.current.id }
    },
    async itemExists(_owner, id) {
      return Boolean(checked(await db.from('marketplace_items').select('id').eq('id', id).maybeSingle()))
    },
    async createComponent(owner, part) {
      if (part.ownerId !== owner || !part.itemId) throw new JobError('Item not found.', 404)
      const parent = checked(await db.from('marketplace_items').select('id').eq('id', part.itemId).maybeSingle())
      if (!parent) throw new JobError('Item not found.', 404)
      const { materialVariants, ...metadata } = part.metadata
      const row = {
        id: part.id, owner_id: owner, item_id: part.itemId, name: part.name, sku: part.sku,
        original_filename: part.originalFilename, gcode: part.gcode, dxf: part.dxf ?? null,
        width: part.width, height: part.height, bounding_box: part.boundingBox, original_bounds: part.originalBounds,
        metadata, date_imported: part.dateImported,
        ...(materialVariants ? { material_variants: materialVariants } : {}),
      }
      const result = await revise(owner, part.itemId, 'add_components', { components: [row] })
      const saved = result.components.find(component => component.component_family_id === part.id)
      return { created: result.changed, id: saved?.id ?? part.id, itemId: result.current.id }
    },
    async componentSource(_owner, itemId, id) {
      const row = checked(await db.from('cnc_components').select('id,item_id,name,sku,original_filename,gcode,dxf,material_variants').eq('item_id', itemId).eq('id', id).maybeSingle())
      if (!row) return undefined
      return {
        id: row.id, itemId: row.item_id, name: row.name, sku: row.sku,
        filename: row.original_filename, gcode: row.gcode, dxf: row.dxf,
        materialVariants: row.material_variants == null ? null : materialVariantsSchema.parse(row.material_variants),
        sha256: await sha256(row.gcode),
      }
    },
    async replaceComponent(owner, itemId, id, input) {
      const row = checked(await db.from('cnc_components').select('id,name,sku,original_filename,dxf,component_family_id,material_variants').eq('item_id', itemId).eq('id', id).maybeSingle())
      if (!row) throw new JobError('Component not found.', 404)
      if (input.dxf !== undefined && row.dxf !== input.expectedDxf) throw new JobError('Component source changed; reload before replacing it.', 409)
      // Validate content using a new-version UUID; the stored source ID can predate UUID imports.
      const storedVariants = row.material_variants == null ? undefined : materialVariantsSchema.parse(row.material_variants)
      // The transaction checks this expected bundle against the current default before publishing.
      const unchangedVariants = storedVariants && JSON.stringify(storedVariants) === JSON.stringify(input.expectedMaterialVariants) ? storedVariants : undefined
      const result = parseComponent({ id: crypto.randomUUID(), name: row.name, sku: row.sku, filename: row.original_filename, dxf: input.dxf ?? row.dxf ?? undefined, gcode: input.gcode, materialVariants: input.materialVariants }, owner, itemId, unchangedVariants)
      const { materialVariants, ...metadata } = result.part.metadata
      const revision = await revise(owner, itemId, 'replace_component', { id, expectedSha256: input.expectedSha256, expectedMaterialVariants: input.expectedMaterialVariants, expectedDxf: row.dxf,
        component: { gcode: result.part.gcode, dxf: result.part.dxf ?? null, material_variants: materialVariants, width: result.part.width, height: result.part.height, bounding_box: result.part.boundingBox, original_bounds: result.part.originalBounds, metadata } })
      const saved = revision.components.find(component => component.component_family_id === (row.component_family_id ?? row.id))
      if (!saved) throw new Error('The replacement version could not be confirmed.')
      return { ...result, part: { ...result.part, id: saved.id, itemId: revision.current.id } }
    },
    async loadComponents(_owner, request: JobRequest) {
      const ids = request.items.flatMap(item => item.itemId ? [item.itemId] : [])
      const skus = request.items.flatMap(item => item.sku ? [item.sku] : [])
      const select = 'id,owner_id,sku,name,description,created_at,updated_at,version_family_id,version_number,version_status,version_default,published_at'
      const byId = ids.length ? checked(await db.from('marketplace_items').select(select).in('id', ids).eq('version_status', 'published').limit(21)) ?? [] : []
      const bySku = skus.length ? checked(await db.from('marketplace_items').select(select).in('sku', skus).eq('version_default', true).limit(21)) ?? [] : []
      const rows = [...new Map([...byId, ...bySku].map(item => [item.id, item])).values()]
      if (rows.length > 20) throw new JobError('Too many matching items or ambiguous SKUs.')
      const items = rows.map(row => ({ id: row.id, ownerId: row.owner_id, sku: row.sku, name: row.name, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at, version: { familyId: row.version_family_id, number: row.version_number, status: row.version_status, isDefault: row.version_default, publishedAt: row.published_at ?? undefined } }))
      const components = rows.length ? checked(await db.from('cnc_components').select('id,owner_id,item_id,sku,name,original_filename,gcode,date_imported,material_variants').in('item_id', rows.map(item => item.id)).order('id').limit(21)) ?? [] : []
      if (components.length > 20 || components.reduce((sum, row) => sum + row.gcode.length + JSON.stringify(row.material_variants ?? {}).length, 0) > 12000000) throw new JobError('Selected component library exceeds the per-job limit. Split the order into smaller jobs.')
      const parts = components.map(row => {
        const part = { ...createPartFromGCode(row.original_filename, row.gcode, undefined, row.item_id), id: row.id, ownerId: row.owner_id, name: row.name, sku: row.sku, dateImported: row.date_imported }
        if (row.material_variants != null) part.metadata.materialVariants = materialVariantsSchema.parse(row.material_variants)
        return part
      })
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
