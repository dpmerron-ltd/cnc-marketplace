-- Apply after item-versions.sql. Private staging never appears in the catalogue.
begin;
create table if not exists public.item_imports (
  id uuid primary key,
  owner_id uuid not null references auth.users(id),
  family_id uuid not null references public.marketplace_items(id),
  expected_version_id uuid not null references public.marketplace_items(id),
  manifest jsonb not null,
  published_item_id uuid references public.marketplace_items(id),
  created_at timestamptz not null default now()
);
create table if not exists public.item_import_entries (
  import_id uuid not null references public.item_imports(id),
  kind text not null check(kind in ('component','profile','document')),
  key text not null,
  payload jsonb not null,
  primary key(import_id,kind,key)
);
alter table public.item_imports enable row level security;
alter table public.item_import_entries enable row level security;
revoke all on public.item_imports,public.item_import_entries from public,anon,authenticated,service_role;

create or replace function public.read_item_import(p_actor uuid,p_item uuid,p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare imp public.item_imports;
begin
  if current_setting('role',true)<>'service_role' or p_actor is null then raise exception 'IMPORT_FORBIDDEN'; end if;
  select * into imp from public.item_imports where id=p_id and owner_id=p_actor
    and family_id=(select version_family_id from public.marketplace_items where id=p_item);
  if not found then raise exception 'IMPORT_NOT_FOUND'; end if;
  return jsonb_build_object('id',imp.id,'expectedVersionId',imp.expected_version_id,'publishedItemId',imp.published_item_id,
    'componentIds',imp.manifest->'componentIds','documentIds',imp.manifest->'documentIds',
    'staged',coalesce((select jsonb_agg(jsonb_build_object('kind',kind,'key',key) order by kind,key) from public.item_import_entries where import_id=p_id),'[]'::jsonb));
end $$;

create or replace function public.begin_item_import(p_actor uuid,p_item uuid,p_id uuid,p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare imp public.item_imports; family uuid; current_id uuid;
begin
  if current_setting('role',true)<>'service_role' or p_actor is null then raise exception 'IMPORT_FORBIDDEN'; end if;
  select version_family_id into family from public.marketplace_items where id=p_item;
  if family is null then raise exception 'IMPORT_NOT_FOUND'; end if;
  perform 1 from public.marketplace_items where id=family for update;
  select * into imp from public.item_imports where id=p_id;
  if found then
    perform public.read_item_import(p_actor,p_item,p_id);
    if imp.manifest is distinct from p_manifest then raise exception 'IMPORT_CONFLICT'; end if;
    return public.read_item_import(p_actor,p_item,p_id);
  end if;
  select id into current_id from public.marketplace_items where version_family_id=family and version_default;
  if current_id is distinct from (p_manifest->>'expectedVersionId')::uuid then raise exception 'IMPORT_CONFLICT'; end if;
  if (p_manifest->>'id')::uuid is distinct from p_id or jsonb_typeof(p_manifest->'componentIds') is distinct from 'array'
    or jsonb_array_length(p_manifest->'componentIds') not between 1 and 100
    or jsonb_typeof(p_manifest->'documentIds') is distinct from 'array' or jsonb_array_length(p_manifest->'documentIds')>20
    or btrim(coalesce(p_manifest->'item'->>'name',''))='' or btrim(coalesce(p_manifest->'item'->>'sku',''))=''
    or not(p_manifest->'item' ? 'image') then raise exception 'IMPORT_INVALID'; end if;
  if (select count(*) from public.item_imports where owner_id=p_actor and published_item_id is null)>=20 then raise exception 'IMPORT_INVALID: too many pending imports'; end if;
  insert into public.item_imports(id,owner_id,family_id,expected_version_id,manifest) values(p_id,p_actor,family,current_id,p_manifest);
  return public.read_item_import(p_actor,p_item,p_id);
end $$;

create or replace function public.stage_item_import(p_actor uuid,p_item uuid,p_id uuid,p_kind text,p_key text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare imp public.item_imports; previous jsonb; component_id text;
begin
  perform public.read_item_import(p_actor,p_item,p_id);
  select * into imp from public.item_imports where id=p_id for update;
  select payload into previous from public.item_import_entries where import_id=p_id and kind=p_kind and key=p_key;
  if found then
    if previous is distinct from p_payload then raise exception 'IMPORT_CONFLICT: staged content is immutable'; end if;
    return public.read_item_import(p_actor,p_item,p_id);
  end if;
  if imp.published_item_id is not null then raise exception 'IMPORT_CONFLICT: already published'; end if;
  if p_kind='component' then
    if not(imp.manifest->'componentIds' ? p_key) or p_payload->>'id' is distinct from p_key then raise exception 'IMPORT_INVALID'; end if;
  elsif p_kind='document' then
    if not(imp.manifest->'documentIds' ? p_key) or p_payload->>'id' is distinct from p_key or p_payload->>'kind' not in ('instructions','packing') then raise exception 'IMPORT_INVALID'; end if;
  elsif p_kind='profile' then
    component_id := p_payload->>'componentId';
    if not(imp.manifest->'componentIds' ? component_id) or p_key is distinct from component_id || '/' || (p_payload->>'profileId')
      or p_payload->>'profileId' not in ('6','12','12-2mm','12-2pass','15','18','18-9mm','12-ramp20-5deg','18-9mm-ramp20-5deg','12-2pass-2mm-ramp20-5deg','12-3pass-2mm-feed60-ramp20-5deg')
      or not exists(select 1 from public.item_import_entries where import_id=p_id and kind='component' and key=component_id) then raise exception 'IMPORT_INVALID'; end if;
  else raise exception 'IMPORT_INVALID'; end if;
  insert into public.item_import_entries(import_id,kind,key,payload) values(p_id,p_kind,p_key,p_payload);
  return public.read_item_import(p_actor,p_item,p_id);
end $$;

create or replace function public.publish_item_import(p_actor uuid,p_item uuid,p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare imp public.item_imports; current_id uuid; new_id uuid; next_number integer; c jsonb; d jsonb; profiles jsonb;
  profile_ids text[] := array['6','12','12-2mm','12-2pass','15','18','18-9mm','12-ramp20-5deg','18-9mm-ramp20-5deg','12-2pass-2mm-ramp20-5deg'];
begin
  perform public.read_item_import(p_actor,p_item,p_id);
  select * into imp from public.item_imports where id=p_id for update;
  if imp.published_item_id is not null then return public.read_item_import(p_actor,p_item,p_id); end if;
  perform 1 from public.marketplace_items where id=imp.family_id for update;
  select id into current_id from public.marketplace_items where version_family_id=imp.family_id and version_default;
  if current_id is distinct from imp.expected_version_id then raise exception 'IMPORT_CONFLICT: default changed'; end if;
  if exists(select 1 from public.marketplace_items where version_family_id=imp.family_id and version_status='draft') then raise exception 'IMPORT_CONFLICT: draft exists'; end if;
  if (select count(*) from public.item_import_entries where import_id=p_id and kind='component')<>jsonb_array_length(imp.manifest->'componentIds')
    or (select count(*) from public.item_import_entries where import_id=p_id and kind='document')<>jsonb_array_length(imp.manifest->'documentIds')
    or (select count(distinct payload->>'sku') from public.item_import_entries where import_id=p_id and kind='component')<>jsonb_array_length(imp.manifest->'componentIds') then raise exception 'IMPORT_INCOMPLETE'; end if;
  new_id := gen_random_uuid();
  select max(version_number)+1 into next_number from public.marketplace_items where version_family_id=imp.family_id;
  insert into public.marketplace_items(id,owner_id,uploaded_by,sku,name,description,packing,image,version_family_id,version_number,version_status,version_default,version_source_id)
    values(new_id,p_actor,p_actor::text,imp.manifest->'item'->>'sku',imp.manifest->'item'->>'name',coalesce(imp.manifest->'item'->>'description',''),'{}'::jsonb,
      nullif(imp.manifest->'item'->'image','null'::jsonb),imp.family_id,next_number,'draft',false,current_id);
  for c in select payload from public.item_import_entries where import_id=p_id and kind='component' order by key loop
    select jsonb_object_agg(payload->>'profileId',payload-array['componentId','profileId']) into profiles from public.item_import_entries
      where import_id=p_id and kind='profile' and payload->>'componentId'=c->>'id';
    if profiles is null or not(profiles ?& profile_ids) or profiles->(c->>'primaryProfile')->>'gcode' is distinct from c->>'gcode' then raise exception 'IMPORT_INCOMPLETE: profiles missing or primary differs'; end if;
    if exists(select 1 from public.cnc_components where id=c->>'id') then raise exception 'IMPORT_CONFLICT: component ID exists'; end if;
    insert into public.cnc_components(id,owner_id,item_id,sku,name,original_filename,gcode,dxf,width,height,bounding_box,original_bounds,metadata,date_imported,material_variants,component_family_id)
      values(c->>'id',p_actor,new_id,c->>'sku',c->>'name',c->>'original_filename',c->>'gcode',c->>'dxf',(c->>'width')::double precision,(c->>'height')::double precision,
        c->'bounding_box',c->'original_bounds',c->'metadata',now(),jsonb_build_object('version',1,'primaryProfile',c->>'primaryProfile','profiles',profiles),c->>'id');
  end loop;
  for d in select payload from public.item_import_entries where import_id=p_id and kind='document' order by key loop
    if not exists(select 1 from storage.objects where bucket_id='cnc-item-documents' and name=p_actor::text || '/' || (d->>'id') || '/document.pdf') then raise exception 'IMPORT_INCOMPLETE: PDF missing'; end if;
    if exists(select 1 from public.item_documents where id=(d->>'id')::uuid) then raise exception 'IMPORT_CONFLICT: document ID exists'; end if;
    insert into public.item_documents(id,owner_id,item_id,kind,filename,file_bytes,pages)
      values((d->>'id')::uuid,p_actor,new_id,d->>'kind',d->>'filename',(d->>'file_bytes')::integer,(d->>'pages')::integer);
  end loop;
  perform public.publish_item_version(p_actor,new_id,current_id);
  update public.item_imports set published_item_id=new_id where id=p_id;
  return public.read_item_import(p_actor,p_item,p_id);
end $$;
revoke all on function public.read_item_import(uuid,uuid,uuid),public.begin_item_import(uuid,uuid,uuid,jsonb),public.stage_item_import(uuid,uuid,uuid,text,text,jsonb),public.publish_item_import(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.read_item_import(uuid,uuid,uuid),public.begin_item_import(uuid,uuid,uuid,jsonb),public.stage_item_import(uuid,uuid,uuid,text,text,jsonb),public.publish_item_import(uuid,uuid,uuid) to service_role;
commit;
