-- Run once on the disposable database, after the other schema tests and before
-- item-versions.sql. Assert the upgrade does not rewrite existing catalogue data.
insert into public.marketplace_items(id,owner_id,sku,name) values
('91000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000009','MIGRATION','Existing rack');
insert into public.cnc_components(id,owner_id,item_id,sku,name,original_filename,gcode,dxf,width,height,bounding_box,original_bounds,metadata,material_variants) values
('migration-component','00000000-0000-4000-8000-000000000009','91000000-0000-4000-8000-000000000001','SIDE','Side','side.nc','G21 G90','DXF',50,60,'{}','{}','{}','{"preserved":true}');
create temporary table original_version_item as select to_jsonb(i) as row from public.marketplace_items i where id='91000000-0000-4000-8000-000000000001';
create temporary table original_version_component as select to_jsonb(c) as row from public.cnc_components c where id='migration-component';
\ir ../item-versions.sql
\ir ../item-versions.sql
do $$ begin
  if (select to_jsonb(i) - array['version_family_id','version_number','version_status','version_default','published_at','version_source_id'] from public.marketplace_items i where id='91000000-0000-4000-8000-000000000001') is distinct from (select row from original_version_item) then raise exception 'Migration changed original item'; end if;
  if (select to_jsonb(c) - array['component_family_id','component_source_id'] from public.cnc_components c where id='migration-component') is distinct from (select row from original_version_component) then raise exception 'Migration changed original component'; end if;
  if not exists(select 1 from public.marketplace_items where id='91000000-0000-4000-8000-000000000001' and version_family_id=id and version_number=1 and version_status='published' and version_default) then raise exception 'Existing item is not default version 1'; end if;
end $$;
