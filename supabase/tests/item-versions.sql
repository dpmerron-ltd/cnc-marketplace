begin;
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on public.marketplace_items, public.cnc_components to authenticated, service_role;
insert into public.marketplace_items(id,owner_id,sku,name,packing) values
('90000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000009','VERSION-TEST','Original rack','{"components":{"original-component":{"thicknessMm":12}}}');
insert into public.cnc_components(id,owner_id,item_id,sku,name,original_filename,gcode,dxf,width,height,bounding_box,original_bounds,metadata,material_variants,component_family_id) values
('original-component','00000000-0000-4000-8000-000000000009','90000000-0000-4000-8000-000000000001','SIDE','Side','side.nc','G21 G90','DXF',50,60,'{}','{}','{}','{"preserved":true}','original-component');
insert into public.sheet_projects(id,owner_id,sheet) values('version-sheet','00000000-0000-4000-8000-000000000009','{"instances":[{"partId":"original-component"}]}');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000009',true);
select set_config('request.jwt.claim.aal','aal2',true);
select id from public.publish_item_version('00000000-0000-4000-8000-000000000009','90000000-0000-4000-8000-000000000001',null);
create function pg_temp.expect_error(command text, pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like '%' || pattern || '%' then raise; end if; return; end;
  raise exception 'Expected error % for %',pattern,command;
end $$;
set local role authenticated;
select pg_temp.expect_error($q$select public.create_item_version('00000000-0000-4000-8000-000000000009','90000000-0000-4000-8000-000000000001',gen_random_uuid())$q$,'permission denied');
select pg_temp.expect_error($q$update public.marketplace_items set name='Overwrite' where id='90000000-0000-4000-8000-000000000001'$q$,'ITEM_VERSION_READ_ONLY');
select pg_temp.expect_error($q$delete from public.cnc_components where id='original-component'$q$,'ITEM_VERSION_READ_ONLY');
do $$ declare result jsonb; current_id uuid; metadata jsonb; component_id text; begin
  metadata := '{"name":"Original rack","sku":"VERSION-TEST","description":"","packing":{"components":{"original-component":{"thicknessMm":12}}}}';
  result := public.update_item_version(auth.uid(),'90000000-0000-4000-8000-000000000001','metadata',jsonb_build_object('expected',metadata,'next',metadata || '{"name":"Revised rack"}'));
  current_id := (result->'current'->>'id')::uuid;
  if result->'current'->>'version_number' <> '2' or result->'current'->>'version_default' <> 'true' then raise exception 'Update did not become default'; end if;
  component_id := result->'components'->0->>'id';
  if component_id='original-component' or result->'current'->'packing'->'components'->component_id <> '{"thicknessMm":12}'::jsonb then raise exception 'Copy or packing remap failed'; end if;
  select jsonb_build_object('name',name,'sku',sku,'description',description,'packing',packing) into metadata from public.marketplace_items where id=current_id;
  result := public.update_item_version(auth.uid(),current_id,'metadata',jsonb_build_object('expected',metadata,'next',metadata));
  if result->>'changed' <> 'false' or result->'current'->>'version_number' <> '2' then raise exception 'Unchanged autosave created history'; end if;
end $$;
select pg_temp.expect_error($q$select public.update_item_version(auth.uid(),'90000000-0000-4000-8000-000000000001','metadata','{"expected":{},"next":{"name":"Conflict","sku":"TEST"}}')$q$,'ITEM_VERSION_CONFLICT');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000010',true);
select pg_temp.expect_error($q$select public.update_item_version('00000000-0000-4000-8000-000000000009','90000000-0000-4000-8000-000000000001','image','{"image":null}')$q$,'ITEM_VERSION_FORBIDDEN');
do $$ declare payload jsonb; result jsonb; begin
  payload := '{"components":[{"id":"new-component","name":"Rail","sku":"RAIL","original_filename":"rail.nc","gcode":"G21 G90","dxf":"DXF","width":10,"height":20,"bounding_box":{},"original_bounds":{},"metadata":{}}]}';
  result := public.update_item_version(auth.uid(),'90000000-0000-4000-8000-000000000001','add_components',payload);
  if result->'current'->>'version_number'<>'3' or jsonb_array_length(result->'components')<>2 then raise exception 'Component version failed'; end if;
  result := public.update_item_version(auth.uid(),'90000000-0000-4000-8000-000000000001','add_components',payload);
  if result->>'changed'<>'false' or result->'current'->>'version_number'<>'3' then raise exception 'Upload retry duplicated revision'; end if;
end $$;
insert into storage.objects(bucket_id,name) values('cnc-item-documents','00000000-0000-4000-8000-000000000010/90000000-0000-4000-8000-000000000011/document.pdf');
select public.update_item_version(auth.uid(),'90000000-0000-4000-8000-000000000001','add_document','{"id":"90000000-0000-4000-8000-000000000011","kind":"packing","filename":"packing.pdf","file_bytes":100,"pages":1}') is not null;
select public.update_item_version(auth.uid(),'90000000-0000-4000-8000-000000000001','image','{"image":{"contentType":"image/png","dataBase64":"YWJjZA=="},"expected":null}') is not null;
select public.update_item_version(auth.uid(),'90000000-0000-4000-8000-000000000001','remove_document','{"id":"90000000-0000-4000-8000-000000000011"}') is not null;
do $$ declare result jsonb; begin
  result := public.update_item_version(auth.uid(),'90000000-0000-4000-8000-000000000001','remove_document','{"id":"90000000-0000-4000-8000-000000000011"}');
  if result->>'changed'<>'false' or result->'current'->>'version_number'<>'6' then raise exception 'Document removal retry created a version'; end if;
end $$;
do $$ begin
  delete from storage.objects where bucket_id='cnc-item-documents';
  if found then raise exception 'Historical PDF bytes deleted'; end if;
  if (select count(*) from public.item_documents where source_document_id='90000000-0000-4000-8000-000000000011' or id='90000000-0000-4000-8000-000000000011') <> 2 then raise exception 'Historical PDFs missing'; end if;
end $$;
select public.update_item_version(auth.uid(),'90000000-0000-4000-8000-000000000001','remove_component','{"id":"new-component"}') is not null;
set local role service_role;
select public.update_item_version('00000000-0000-4000-8000-000000000010','90000000-0000-4000-8000-000000000001','replace_component',jsonb_build_object('id','original-component','expectedSha256',encode(sha256('G21 G90'::bytea),'hex'),'expectedMaterialVariants','{"preserved":true}'::jsonb,'expectedDxf','DXF','component','{"gcode":"G21 G90 G17","dxf":"NEW DXF","material_variants":{"new":true},"width":50,"height":60,"bounding_box":{},"original_bounds":{},"metadata":{}}'::jsonb)) is not null;
select pg_temp.expect_error($q$select public.replace_cnc_component_gcode('00000000-0000-4000-8000-000000000009','90000000-0000-4000-8000-000000000001','original-component',encode(sha256('G21 G90'::bytea),'hex'),'{"preserved":true}','DXF','changed',null,50,60,'{}','{}','{}')$q$,'ITEM_VERSION_READ_ONLY');
reset role;
do $$ declare current_id uuid; begin
  select id into current_id from public.marketplace_items where version_family_id='90000000-0000-4000-8000-000000000001' and version_default;
  if (select version_number from public.marketplace_items where id=current_id)<>8 then raise exception 'Unexpected revision count'; end if;
  if (select count(*) from public.cnc_components where item_id=current_id)<>1 then raise exception 'Removal not applied to current version'; end if;
  if (select gcode from public.cnc_components where item_id=current_id)<>'G21 G90 G17' then raise exception 'Replacement missing'; end if;
  if (select gcode from public.cnc_components where id='original-component')<>'G21 G90' then raise exception 'Historical NC changed'; end if;
  if (select name from public.marketplace_items where id='90000000-0000-4000-8000-000000000001')<>'Original rack' then raise exception 'Historical name changed'; end if;
  if (select sheet from public.sheet_projects where id='version-sheet')<>'{"instances":[{"partId":"original-component"}]}'::jsonb then raise exception 'Sheet was retargeted'; end if;
  if exists(select 1 from public.marketplace_items where version_status='draft') then raise exception 'Incomplete version leaked'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.aal','aal1',true);
select pg_temp.expect_error($q$select public.update_item_version(auth.uid(),'90000000-0000-4000-8000-000000000001','image','{"image":null}')$q$,'ITEM_VERSION_FORBIDDEN');
reset role;
rollback;
