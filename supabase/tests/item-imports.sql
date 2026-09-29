begin;
grant usage on schema public to service_role;
grant select on public.marketplace_items,public.cnc_components,public.item_documents to service_role;
insert into public.marketplace_items(id,owner_id,sku,name) values
('92000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000009','IMPORT-TEST','Original bench');
insert into public.cnc_components(id,owner_id,item_id,sku,name,original_filename,gcode,dxf,width,height,bounding_box,original_bounds,metadata,component_family_id) values
('import-original','00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001','OLD','Original','old.nc','ORIGINAL NC','ORIGINAL DXF',10,20,'{}','{}','{}','import-original');
insert into storage.objects(bucket_id,name) values('cnc-item-documents','00000000-0000-4000-8000-000000000009/92000000-0000-4000-8000-000000000040/document.pdf');
insert into public.item_documents(id,owner_id,item_id,kind,filename,file_bytes,pages) values
('92000000-0000-4000-8000-000000000040','00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001','instructions','old.pdf',100,1);
insert into public.sheet_projects(id,owner_id,sheet) values('import-sheet','00000000-0000-4000-8000-000000000009','{"instances":[{"partId":"import-original"}]}');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000009',true);
select set_config('request.jwt.claim.aal','aal2',true);
select id from public.publish_item_version('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001',null);
create function pg_temp.expect_import_error(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like '%' || pattern || '%' then raise; end if; return; end;
  raise exception 'Expected error %',pattern;
end $$;
set local role authenticated;
select pg_temp.expect_import_error($q$select * from public.item_imports$q$,'permission denied');
select pg_temp.expect_import_error($q$select * from public.item_import_entries$q$,'permission denied');
select pg_temp.expect_import_error($q$select public.read_item_import('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000101')$q$,'permission denied');
set local role anon;
select pg_temp.expect_import_error($q$select public.publish_item_import('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000101')$q$,'permission denied');
set local role service_role;
do $$ declare imp uuid; manifest jsonb; result jsonb; profile text; begin
  foreach imp in array array['92000000-0000-4000-8000-000000000101'::uuid,'92000000-0000-4000-8000-000000000102'::uuid] loop
    manifest := jsonb_build_object('id',imp,'expectedVersionId','92000000-0000-4000-8000-000000000001','item','{"name":"Revision C","sku":"IMPORT-TEST","description":"New geometry","image":null}'::jsonb,
      'componentIds','["92000000-0000-4000-8000-000000000031"]'::jsonb,'documentIds','["92000000-0000-4000-8000-000000000041"]'::jsonb);
    result := public.begin_item_import('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001',imp,manifest);
    if result is distinct from public.begin_item_import('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001',imp,manifest) then raise exception 'Start retry differs'; end if;
    perform public.stage_item_import('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001',imp,'component','92000000-0000-4000-8000-000000000031',
      '{"id":"92000000-0000-4000-8000-000000000031","sku":"SIDE-RC","name":"New side","original_filename":"new.nc","gcode":"NEW NC","dxf":"NEW DXF","width":30,"height":40,"bounding_box":{},"original_bounds":{},"metadata":{},"primaryProfile":"12-2mm"}');
    foreach profile in array array['6','12','12-2mm','12-2pass','15','18','18-9mm','12-ramp20-5deg','18-9mm-ramp20-5deg','12-2pass-2mm-ramp20-5deg'] loop
      perform public.stage_item_import('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001',imp,'profile','92000000-0000-4000-8000-000000000031/'||profile,
        jsonb_build_object('componentId','92000000-0000-4000-8000-000000000031','profileId',profile,'gcode','NEW NC','warnings','[]'::jsonb,'errors','[]'::jsonb));
    end loop;
  end loop;
  if (select count(*) from public.marketplace_items where version_family_id='92000000-0000-4000-8000-000000000001')<>1 then raise exception 'Staging leaked catalogue versions'; end if;
end $$;
select pg_temp.expect_import_error($q$select public.read_item_import('00000000-0000-4000-8000-000000000010','92000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000101')$q$,'IMPORT_NOT_FOUND');
select pg_temp.expect_import_error($q$select public.read_item_import('00000000-0000-4000-8000-000000000009','91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000101')$q$,'IMPORT_NOT_FOUND');
select pg_temp.expect_import_error($q$select public.stage_item_import('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000101','component','92000000-0000-4000-8000-000000000031','{}')$q$,'IMPORT_CONFLICT');
select pg_temp.expect_import_error($q$select public.stage_item_import('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000101','component','not-declared','{}')$q$,'IMPORT_INVALID');
select pg_temp.expect_import_error($q$select public.publish_item_import('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000101')$q$,'IMPORT_INCOMPLETE');
select public.stage_item_import('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000101','document','92000000-0000-4000-8000-000000000041',
  '{"id":"92000000-0000-4000-8000-000000000041","kind":"packing","filename":"new.pdf","file_bytes":123,"pages":2}') is not null;
-- This fails after inserting the provisional version and NC inside the transaction.
select pg_temp.expect_import_error($q$select public.publish_item_import('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000101')$q$,'IMPORT_INCOMPLETE');
reset role;
do $$ begin
  if (select count(*) from public.marketplace_items where version_family_id='92000000-0000-4000-8000-000000000001')<>1
    or exists(select 1 from public.cnc_components where id='92000000-0000-4000-8000-000000000031') then raise exception 'Failed publish left partial data'; end if;
end $$;
insert into storage.objects(bucket_id,name) values('cnc-item-documents','00000000-0000-4000-8000-000000000009/92000000-0000-4000-8000-000000000041/document.pdf');
set local role service_role;
do $$ declare result jsonb; new_id uuid; begin
  result := public.publish_item_import('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000101');
  new_id := (result->>'publishedItemId')::uuid;
  if new_id is null or result is distinct from public.publish_item_import('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000101') then raise exception 'Publish retry not idempotent'; end if;
  if not exists(select 1 from public.marketplace_items where id=new_id and version_default and version_number=2 and name='Revision C') then raise exception 'New default missing'; end if;
  if (select count(*) from public.cnc_components where item_id=new_id)<>1 or (select count(*) from public.item_documents where item_id=new_id)<>1 then raise exception 'Complete replacement failed'; end if;
  if not exists(select 1 from public.cnc_components where item_id=new_id and sku='SIDE-RC' and dxf='NEW DXF' and material_variants->>'primaryProfile'='12-2mm') then raise exception 'New geometry/metadata missing'; end if;
end $$;
select pg_temp.expect_import_error($q$select public.publish_item_import('00000000-0000-4000-8000-000000000009','92000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000102')$q$,'IMPORT_CONFLICT');
reset role;
do $$ begin
  if (select count(*) from public.marketplace_items where version_family_id='92000000-0000-4000-8000-000000000001')<>2 then raise exception 'Extra versions created'; end if;
  if (select gcode from public.cnc_components where id='import-original')<>'ORIGINAL NC'
    or (select filename from public.item_documents where id='92000000-0000-4000-8000-000000000040')<>'old.pdf'
    or (select sheet from public.sheet_projects where id='import-sheet')<>'{"instances":[{"partId":"import-original"}]}'::jsonb then raise exception 'Original data changed'; end if;
end $$;
rollback;
