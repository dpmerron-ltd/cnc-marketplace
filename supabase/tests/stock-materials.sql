-- Run after item-versions.sql in a disposable database.
begin;
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on public.marketplace_items, public.cnc_components to authenticated, service_role;
insert into public.marketplace_items(id,owner_id,sku,name,default_material) values
('94000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000009','MATERIALS','Mixed cabinet','{"thicknessMm":12,"type":"Plywood","finish":"Natural"}');
insert into public.cnc_components(id,owner_id,item_id,sku,name,original_filename,gcode,width,height,bounding_box,original_bounds,metadata,component_family_id,cut_side,stock_material) values
('stock-front','00000000-0000-4000-8000-000000000009','94000000-0000-4000-8000-000000000001','FRONT','Front','front.nc','ORIGINAL FRONT',50,50,'{}','{}','{}','stock-front','pattern','{"thicknessMm":12,"type":"Plywood","finish":"Black hex"}'),
('stock-back','00000000-0000-4000-8000-000000000009','94000000-0000-4000-8000-000000000001','BACK','Back','back.nc','ORIGINAL BACK',50,50,'{}','{}','{}','stock-back','non-pattern',null);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000009',true);
select set_config('request.jwt.claim.aal','aal2',true);
select id from public.publish_item_version('00000000-0000-4000-8000-000000000009','94000000-0000-4000-8000-000000000001',null);
create function pg_temp.expect_material_error(command text, pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like '%' || pattern || '%' then raise; end if; return; end;
  raise exception 'Expected error %',pattern;
end $$;
set local role authenticated;
select pg_temp.expect_material_error($q$update public.cnc_components set stock_material=null where id='stock-front'$q$,'ITEM_VERSION_READ_ONLY');
select pg_temp.expect_material_error($q$select public.update_item_version(auth.uid(),'94000000-0000-4000-8000-000000000001','materials','{"expectedVersionId":"94000000-0000-4000-8000-000000000001","defaultMaterial":{"thicknessMm":0,"type":"Plywood","finish":"Natural"},"components":{}}')$q$,'ITEM_VERSION_INVALID');
select pg_temp.expect_material_error($q$select public.update_item_version(auth.uid(),'94000000-0000-4000-8000-000000000001','materials','{"expectedVersionId":"94000000-0000-4000-8000-000000000001","defaultMaterial":null,"components":{"missing":null}}')$q$,'ITEM_VERSION_INVALID');
do $$ declare result jsonb; next_id uuid; original_id uuid := '94000000-0000-4000-8000-000000000001'; begin
  result := public.update_item_version(auth.uid(),original_id,'materials',jsonb_build_object('expectedVersionId',original_id,'defaultMaterial','{"thicknessMm":18,"type":"Plywood","finish":"Natural"}'::jsonb,'components','{"stock-front":null,"stock-back":{"thicknessMm":12,"type":"Plywood","finish":"White"}}'::jsonb));
  next_id := (result->'current'->>'id')::uuid;
  if result->'current'->>'version_number'<>'2' then raise exception 'Material edit did not create exactly one revision'; end if;
  if result->'current'->'default_material'->>'thicknessMm'<>'18' then raise exception 'Default stock missing'; end if;
  if not exists(select 1 from public.cnc_components where item_id=next_id and component_family_id='stock-front' and stock_material is null and gcode='ORIGINAL FRONT' and cut_side='pattern') then raise exception 'Override clearing damaged program or face'; end if;
  if not exists(select 1 from jsonb_array_elements(result->'components') c where c->>'component_family_id'='stock-back' and c->'stock_material'->>'finish'='White') then raise exception 'Response lost material override'; end if;
  if (select default_material->>'thicknessMm' from public.marketplace_items where id=original_id)<>'12' or (select stock_material->>'finish' from public.cnc_components where id='stock-front')<>'Black hex' then raise exception 'Historical requirements changed'; end if;
  result := public.update_item_version(auth.uid(),next_id,'image','{"image":null}');
  if result->'current'->'default_material'->>'thicknessMm'<>'18' then raise exception 'Unrelated update lost stock'; end if;
end $$;
select pg_temp.expect_material_error($q$select public.update_item_version(auth.uid(),'94000000-0000-4000-8000-000000000001','materials','{"expectedVersionId":"94000000-0000-4000-8000-000000000001","defaultMaterial":null,"components":{}}')$q$,'ITEM_VERSION_CONFLICT');
select set_config('request.jwt.claim.aal','aal1',true);
select pg_temp.expect_material_error($q$select public.update_item_version(auth.uid(),'94000000-0000-4000-8000-000000000001','materials','{}')$q$,'ITEM_VERSION_FORBIDDEN');
reset role;
rollback;
