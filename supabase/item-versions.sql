-- Run after schema.sql and item-documents.sql. Existing programs keep their IDs.
begin;
alter table public.marketplace_items add column if not exists version_family_id uuid;
alter table public.marketplace_items add column if not exists version_number integer not null default 1;
alter table public.marketplace_items add column if not exists version_status text not null default 'draft';
alter table public.marketplace_items add column if not exists version_default boolean not null default false;
alter table public.marketplace_items add column if not exists published_at timestamptz;
alter table public.marketplace_items add column if not exists version_source_id uuid references public.marketplace_items(id);
update public.marketplace_items set version_family_id = id, version_status = 'published', version_default = true, published_at = updated_at where version_family_id is null;
alter table public.marketplace_items alter column version_family_id set not null;
create unique index if not exists item_version_number on public.marketplace_items(version_family_id, version_number);
create unique index if not exists item_version_default on public.marketplace_items(version_family_id) where version_default;
create unique index if not exists item_version_draft on public.marketplace_items(version_family_id) where version_status = 'draft';
alter table public.marketplace_items drop constraint if exists item_version_valid;
alter table public.marketplace_items add constraint item_version_valid check (version_number > 0 and version_status in ('draft', 'published') and (not version_default or version_status = 'published'));
alter table public.marketplace_items drop constraint if exists item_version_family_fk;
alter table public.marketplace_items add constraint item_version_family_fk foreign key(version_family_id) references public.marketplace_items(id) on delete restrict;
alter table public.cnc_components add column if not exists component_family_id text;
alter table public.cnc_components add column if not exists component_source_id text;
update public.cnc_components set component_family_id=id where component_family_id is null;
create unique index if not exists component_version_family on public.cnc_components(item_id,component_family_id) where component_family_id is not null;

-- A cloned PDF references the same immutable storage object. Keeping any version
-- prevents that object's deletion; no PDF bytes need to pass through the client.
alter table public.item_documents add column if not exists source_document_id uuid;
alter table public.item_documents add column if not exists source_owner_id uuid;
alter table public.item_documents drop constraint if exists item_document_source_valid;
alter table public.item_documents add constraint item_document_source_valid check ((source_document_id is null) = (source_owner_id is null));
alter table public.item_documents drop column if exists file_path;
alter table public.item_documents add column file_path text generated always as (coalesce(source_owner_id, owner_id)::text || '/' || coalesce(source_document_id, id)::text || '/document.pdf') stored;

create or replace function public.guard_item_version()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    new.version_family_id := coalesce(new.version_family_id, new.id);
    if current_user in ('authenticated', 'anon', 'service_role') and
      (new.version_family_id <> new.id or new.version_number <> 1 or new.version_status <> 'draft' or new.version_default or new.published_at is not null or new.version_source_id is not null)
    then raise exception 'ITEM_VERSION_READ_ONLY'; end if;
    if current_user in ('authenticated', 'service_role') then
      new.version_status := 'published'; new.version_default := true; new.published_at := now();
    end if;
    return new;
  end if;
  if TG_OP = 'DELETE' then
    raise exception 'ITEM_VERSION_READ_ONLY: version history cannot be deleted';
  end if;
  if current_user in ('authenticated', 'anon', 'service_role') and
    row(new.version_family_id, new.version_number, new.version_status, new.version_default, new.published_at, new.version_source_id)
      is distinct from row(old.version_family_id, old.version_number, old.version_status, old.version_default, old.published_at, old.version_source_id)
  then raise exception 'ITEM_VERSION_READ_ONLY'; end if;
  if old.version_status = 'published' and
    (to_jsonb(new) - array['version_default','updated_at']) is distinct from (to_jsonb(old) - array['version_default','updated_at'])
  then raise exception 'ITEM_VERSION_READ_ONLY: use the versioned update endpoint'; end if;
  return new;
end $$;
drop trigger if exists guard_item_version on public.marketplace_items;
create trigger guard_item_version before insert or update or delete on public.marketplace_items for each row execute function public.guard_item_version();

create or replace function public.guard_item_version_content()
returns trigger language plpgsql set search_path = '' as $$
declare target uuid; state text;
begin
  target := case when TG_OP = 'DELETE' then old.item_id else new.item_id end;
  -- Share the parent lock with publish. A racing upload either finishes first,
  -- or fails without modifying the newly published revision.
  select version_status into state from public.marketplace_items where id = target for update;
  if state is distinct from 'draft' then
    if TG_OP = 'UPDATE' and new is not distinct from old then return new; end if;
    raise exception 'ITEM_VERSION_READ_ONLY: use the versioned update endpoint';
  end if;
  if TG_OP = 'UPDATE' and new.item_id is distinct from old.item_id then raise exception 'ITEM_VERSION_READ_ONLY: components cannot move between versions'; end if;
  if TG_TABLE_NAME = 'item_documents' and TG_OP = 'INSERT' and current_user in ('authenticated','anon','service_role') then
    if new.source_document_id is not null or new.source_owner_id is not null then raise exception 'ITEM_VERSION_READ_ONLY'; end if;
  end if;
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists guard_item_version_content on public.cnc_components;
create trigger guard_item_version_content before insert or update or delete on public.cnc_components for each row execute function public.guard_item_version_content();
drop trigger if exists guard_item_version_content on public.item_documents;
create trigger guard_item_version_content before insert or update or delete on public.item_documents for each row execute function public.guard_item_version_content();

create or replace function public.create_item_version(p_actor uuid, p_source uuid, p_id uuid)
returns public.marketplace_items language plpgsql security definer set search_path = '' as $$
declare source public.marketplace_items; result public.marketplace_items; next_number integer; component public.cnc_components; component_id text; packing_components jsonb := '{}';
begin
  if p_actor is null or (current_setting('role', true) <> 'service_role' and (auth.uid() is distinct from p_actor or coalesce(auth.jwt()->>'aal','') <> 'aal2')) then raise exception 'ITEM_VERSION_FORBIDDEN'; end if;
  select * into source from public.marketplace_items where id = p_source;
  if not found then raise exception 'ITEM_VERSION_NOT_FOUND'; end if;
  perform 1 from public.marketplace_items where id = source.version_family_id for update;
  select * into result from public.marketplace_items where id = p_id;
  if found then
    if result.version_source_id = p_source and result.owner_id = p_actor then return result; end if;
    raise exception 'ITEM_VERSION_CONFLICT';
  end if;
  if source.version_status <> 'published' then raise exception 'ITEM_VERSION_CONFLICT: publish the draft first'; end if;
  if exists(select 1 from public.marketplace_items where version_family_id = source.version_family_id and version_status = 'draft') then raise exception 'ITEM_VERSION_CONFLICT: this item already has a draft'; end if;
  select max(version_number) + 1 into next_number from public.marketplace_items where version_family_id = source.version_family_id;
  insert into public.marketplace_items(id,owner_id,uploaded_by,sku,name,description,packing,image,version_family_id,version_number,version_status,version_default,version_source_id)
    values(p_id,p_actor,p_actor::text,source.sku,source.name,source.description,source.packing,source.image,source.version_family_id,next_number,'draft',false,p_source) returning * into result;
  for component in select * from public.cnc_components where item_id = p_source loop
    component_id := gen_random_uuid()::text;
    insert into public.cnc_components(id,owner_id,item_id,sku,name,original_filename,gcode,dxf,width,height,bounding_box,original_bounds,metadata,date_imported,material_variants,component_family_id,component_source_id)
      values(component_id,component.owner_id,p_id,component.sku,component.name,component.original_filename,component.gcode,component.dxf,component.width,component.height,component.bounding_box,component.original_bounds,component.metadata,component.date_imported,component.material_variants,coalesce(component.component_family_id,component.id),component.id);
    if source.packing->'components' ? component.id then packing_components := packing_components || jsonb_build_object(component_id,source.packing->'components'->component.id); end if;
  end loop;
  if source.packing ? 'components' then update public.marketplace_items set packing = jsonb_set(packing,'{components}',packing_components) where id = p_id returning * into result; end if;
  insert into public.item_documents(id,owner_id,item_id,kind,filename,file_bytes,pages,source_document_id,source_owner_id)
    select gen_random_uuid(),owner_id,p_id,kind,filename,file_bytes,pages,coalesce(source_document_id,id),coalesce(source_owner_id,owner_id) from public.item_documents where item_id = p_source;
  return result;
end $$;

create or replace function public.publish_item_version(p_actor uuid, p_id uuid, p_expected_default uuid)
returns public.marketplace_items language plpgsql security definer set search_path = '' as $$
declare result public.marketplace_items; current_id uuid;
begin
  if p_actor is null or (current_setting('role', true) <> 'service_role' and (auth.uid() is distinct from p_actor or coalesce(auth.jwt()->>'aal','') <> 'aal2')) then raise exception 'ITEM_VERSION_FORBIDDEN'; end if;
  select * into result from public.marketplace_items where id = p_id;
  if not found then raise exception 'ITEM_VERSION_NOT_FOUND'; end if;
  perform 1 from public.marketplace_items where id = result.version_family_id for update;
  select * into result from public.marketplace_items where id = p_id for update;
  if result.version_status = 'published' and result.version_default then return result; end if;
  if result.version_status <> 'draft' then raise exception 'ITEM_VERSION_CONFLICT'; end if;
  select id into current_id from public.marketplace_items where version_family_id = result.version_family_id and version_default;
  if current_id is distinct from p_expected_default then raise exception 'ITEM_VERSION_CONFLICT: default changed'; end if;
  if btrim(result.name) = '' or btrim(result.sku) = '' then raise exception 'ITEM_VERSION_INVALID: item name and SKU are required'; end if;
  update public.marketplace_items set version_default = false where id = current_id;
  update public.marketplace_items set version_default = true,version_status = 'published',published_at = now(),updated_at = now() where id = p_id returning * into result;
  return result;
end $$;
revoke all on function public.guard_item_version(), public.guard_item_version_content() from public, anon, authenticated;
revoke all on function public.create_item_version(uuid,uuid,uuid), public.publish_item_version(uuid,uuid,uuid) from public, anon;
grant execute on function public.create_item_version(uuid,uuid,uuid), public.publish_item_version(uuid,uuid,uuid) to authenticated, service_role;

create or replace function public.item_update_result(p_id uuid, p_changed boolean)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('changed',p_changed,'current',to_jsonb(i),
    'previous',(select to_jsonb(previous) from public.marketplace_items previous where previous.id=i.version_source_id),
    'components',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'owner_id',c.owner_id,'item_id',c.item_id,'sku',c.sku,'name',c.name,'original_filename',c.original_filename,'width',c.width,'height',c.height,'component_family_id',c.component_family_id,'component_source_id',c.component_source_id,'material_profile',c.material_variants->>'primaryProfile')) from public.cnc_components c where c.item_id=i.id),'[]'::jsonb))
  from public.marketplace_items i where i.id=p_id
$$;

create or replace function public.update_item_version(p_actor uuid, p_item uuid, p_action text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare family uuid; current_item public.marketplace_items; next_item public.marketplace_items;
  component public.cnc_components; target_component public.cnc_components; document public.item_documents;
  entry jsonb; logical_id text; old_metadata jsonb; new_metadata jsonb; additions integer := 0;
begin
  if p_actor is null or (current_setting('role',true) <> 'service_role' and (auth.uid() is distinct from p_actor or coalesce(auth.jwt()->>'aal','') <> 'aal2')) then raise exception 'ITEM_VERSION_FORBIDDEN'; end if;
  select version_family_id into family from public.marketplace_items where id=p_item;
  if family is null then raise exception 'ITEM_VERSION_NOT_FOUND'; end if;
  perform 1 from public.marketplace_items where id=family for update;
  select * into current_item from public.marketplace_items where version_family_id=family and version_default;
  if not found then raise exception 'ITEM_VERSION_NOT_FOUND'; end if;

  if p_action='metadata' then
    old_metadata := jsonb_build_object('sku',current_item.sku,'name',current_item.name,'description',current_item.description,'packing',current_item.packing);
    new_metadata := p_payload->'next';
    if old_metadata=new_metadata then return public.item_update_result(current_item.id,false); end if;
    if old_metadata is distinct from p_payload->'expected' then raise exception 'ITEM_VERSION_CONFLICT: metadata changed'; end if;
    if btrim(coalesce(new_metadata->>'sku',''))='' or btrim(coalesce(new_metadata->>'name',''))='' then raise exception 'ITEM_VERSION_INVALID'; end if;
  elsif p_action='image' then
    if current_item.image is not distinct from nullif(p_payload->'image','null'::jsonb) then return public.item_update_result(current_item.id,false); end if;
    if p_payload ? 'expected' and current_item.image is distinct from nullif(p_payload->'expected','null'::jsonb) then raise exception 'ITEM_VERSION_CONFLICT: image changed'; end if;
  elsif p_action='add_components' then
    if jsonb_typeof(p_payload->'components') is distinct from 'array' or jsonb_array_length(p_payload->'components') not between 1 and 100 then raise exception 'ITEM_VERSION_INVALID'; end if;
    for entry in select * from jsonb_array_elements(p_payload->'components') loop
      select * into component from public.cnc_components where item_id=current_item.id and coalesce(component_family_id,id)=entry->>'id';
      if found then
        if component.owner_id<>p_actor or row(component.name,component.sku,component.gcode,component.dxf,component.material_variants,component.original_filename)
          is distinct from row(entry->>'name',entry->>'sku',entry->>'gcode',entry->>'dxf',nullif(entry->'material_variants','null'::jsonb),entry->>'original_filename') then raise exception 'ITEM_VERSION_CONFLICT: component ID reused'; end if;
      else
        if exists(select 1 from public.cnc_components where id=entry->>'id') then raise exception 'ITEM_VERSION_CONFLICT: component ID already exists'; end if;
        additions := additions+1;
      end if;
    end loop;
    if additions=0 then return public.item_update_result(current_item.id,false); end if;
  elsif p_action in ('remove_component','replace_component') then
    select c.* into component from public.cnc_components c join public.marketplace_items i on i.id=c.item_id where c.id=p_payload->>'id' and i.version_family_id=family;
    if not found then raise exception 'ITEM_VERSION_NOT_FOUND'; end if;
    logical_id := coalesce(component.component_family_id,component.id);
    select * into target_component from public.cnc_components where item_id=current_item.id and coalesce(component_family_id,id)=logical_id;
    if not found then raise exception 'ITEM_VERSION_CONFLICT: component already removed'; end if;
    if p_action='replace_component' then
      if current_setting('role',true) <> 'service_role' then raise exception 'ITEM_VERSION_FORBIDDEN'; end if;
      if encode(sha256(convert_to(target_component.gcode,'UTF8')),'hex') is distinct from p_payload->>'expectedSha256'
        or target_component.material_variants is distinct from nullif(p_payload->'expectedMaterialVariants','null'::jsonb)
        or target_component.dxf is distinct from p_payload->>'expectedDxf' then raise exception 'COMPONENT_REVISION_CONFLICT'; end if;
    end if;
  elsif p_action='add_document' then
    if exists(select 1 from public.item_documents where id=(p_payload->>'id')::uuid) then raise exception 'ITEM_VERSION_CONFLICT: document ID already exists'; end if;
    if not exists(select 1 from storage.objects where bucket_id='cnc-item-documents' and name=p_actor::text || '/' || (p_payload->>'id') || '/document.pdf') then raise exception 'ITEM_VERSION_INVALID: PDF upload missing'; end if;
  elsif p_action='remove_document' then
    select d.* into document from public.item_documents d join public.marketplace_items i on i.id=d.item_id where d.id=(p_payload->>'id')::uuid and i.version_family_id=family;
    if not found then raise exception 'ITEM_VERSION_NOT_FOUND'; end if;
    if document.owner_id<>p_actor then raise exception 'ITEM_VERSION_FORBIDDEN'; end if;
    if not exists(select 1 from public.item_documents where item_id=current_item.id and coalesce(source_document_id,id)=coalesce(document.source_document_id,document.id)) then
      return public.item_update_result(current_item.id,false);
    end if;
  else raise exception 'ITEM_VERSION_INVALID'; end if;

  next_item := public.create_item_version(p_actor,current_item.id,gen_random_uuid());
  if p_action='metadata' then
    -- Component IDs change on copy; remap per-component packing overrides.
    if new_metadata->'packing' ? 'components' then
      new_metadata := jsonb_set(new_metadata,'{packing,components}',coalesce((select jsonb_object_agg(c.id,new_metadata->'packing'->'components'->c.component_source_id) from public.cnc_components c where c.item_id=next_item.id and new_metadata->'packing'->'components' ? c.component_source_id),'{}'::jsonb));
    end if;
    update public.marketplace_items set sku=new_metadata->>'sku',name=new_metadata->>'name',description=coalesce(new_metadata->>'description',''),packing=coalesce(new_metadata->'packing','{}') where id=next_item.id;
  elsif p_action='image' then
    update public.marketplace_items set image=nullif(p_payload->'image','null'::jsonb) where id=next_item.id;
  elsif p_action='add_components' then
    for entry in select * from jsonb_array_elements(p_payload->'components') loop
      if exists(select 1 from public.cnc_components where item_id=next_item.id and component_family_id=entry->>'id') then continue; end if;
      insert into public.cnc_components(id,owner_id,item_id,sku,name,original_filename,gcode,dxf,width,height,bounding_box,original_bounds,metadata,date_imported,material_variants,component_family_id)
      values(entry->>'id',p_actor,next_item.id,entry->>'sku',entry->>'name',entry->>'original_filename',entry->>'gcode',entry->>'dxf',(entry->>'width')::double precision,(entry->>'height')::double precision,entry->'bounding_box',entry->'original_bounds',entry->'metadata',coalesce((entry->>'date_imported')::timestamptz,now()),nullif(entry->'material_variants','null'::jsonb),entry->>'id');
    end loop;
  elsif p_action='remove_component' then
    delete from public.cnc_components where item_id=next_item.id and component_family_id=logical_id;
  elsif p_action='replace_component' then
    entry := p_payload->'component';
    update public.cnc_components set gcode=entry->>'gcode',dxf=entry->>'dxf',material_variants=nullif(entry->'material_variants','null'::jsonb),width=(entry->>'width')::double precision,height=(entry->>'height')::double precision,bounding_box=entry->'bounding_box',original_bounds=entry->'original_bounds',metadata=entry->'metadata'
    where item_id=next_item.id and component_family_id=logical_id;
  elsif p_action='add_document' then
    insert into public.item_documents(id,owner_id,item_id,kind,filename,file_bytes,pages) values((p_payload->>'id')::uuid,p_actor,next_item.id,p_payload->>'kind',p_payload->>'filename',(p_payload->>'file_bytes')::integer,(p_payload->>'pages')::integer);
  elsif p_action='remove_document' then
    delete from public.item_documents where item_id=next_item.id and coalesce(source_document_id,id)=coalesce(document.source_document_id,document.id);
  end if;
  next_item := public.publish_item_version(p_actor,next_item.id,current_item.id);
  return public.item_update_result(next_item.id,true);
end $$;
revoke all on function public.create_item_version(uuid,uuid,uuid),public.publish_item_version(uuid,uuid,uuid),public.item_update_result(uuid,boolean) from public,anon,authenticated,service_role;
revoke all on function public.update_item_version(uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.update_item_version(uuid,uuid,text,jsonb) to authenticated,service_role;
commit;
