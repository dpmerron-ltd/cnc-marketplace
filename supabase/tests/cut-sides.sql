-- Run after item-versions.sql in a disposable database.
begin;
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on public.marketplace_items, public.cnc_components to authenticated, service_role;
insert into public.marketplace_items(id,owner_id,sku,name) values
('93000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000009','FACES','Patterned cabinet');
insert into public.cnc_components(id,owner_id,item_id,sku,name,original_filename,gcode,width,height,bounding_box,original_bounds,metadata,component_family_id,cut_side) values
('face-front','00000000-0000-4000-8000-000000000009','93000000-0000-4000-8000-000000000001','FRONT','Front','front.nc','ORIGINAL FRONT',50,50,'{}','{}','{}','face-front','pattern'),
('face-back','00000000-0000-4000-8000-000000000009','93000000-0000-4000-8000-000000000001','BACK','Back','back.nc','ORIGINAL BACK',50,50,'{}','{}','{}','face-back','non-pattern');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000009',true);
select set_config('request.jwt.claim.aal','aal2',true);
select id from public.publish_item_version('00000000-0000-4000-8000-000000000009','93000000-0000-4000-8000-000000000001',null);
create function pg_temp.expect_face_error(command text, pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like '%' || pattern || '%' then raise; end if; return; end;
  raise exception 'Expected error %',pattern;
end $$;
set local role authenticated;
select pg_temp.expect_face_error($q$update public.cnc_components set cut_side='either' where id='face-front'$q$,'ITEM_VERSION_READ_ONLY');
select pg_temp.expect_face_error($q$select public.update_item_version(auth.uid(),'93000000-0000-4000-8000-000000000001','cut_side','{"id":"face-front","cutSide":"up","expectedCutSide":"pattern"}')$q$,'ITEM_VERSION_INVALID');
select pg_temp.expect_face_error($q$select public.update_item_version(auth.uid(),'93000000-0000-4000-8000-000000000001','cut_side','{"id":"face-front","cutSide":"either","expectedCutSide":"non-pattern"}')$q$,'ITEM_VERSION_CONFLICT');
do $$ declare result jsonb; next_id uuid; original_id uuid := '93000000-0000-4000-8000-000000000001'; begin
  result := public.update_item_version(auth.uid(),original_id,'cut_side','{"id":"face-front","cutSide":"either","expectedCutSide":"pattern"}');
  next_id := (result->'current'->>'id')::uuid;
  if result->'current'->>'version_number'<>'2' then raise exception 'Face edit did not create one revision'; end if;
  if not exists(select 1 from public.cnc_components where item_id=next_id and component_family_id='face-front' and cut_side='either' and gcode='ORIGINAL FRONT') then raise exception 'Face edit altered program or was not saved'; end if;
  if not exists(select 1 from public.cnc_components where item_id=next_id and component_family_id='face-back' and cut_side='non-pattern') then raise exception 'Clone lost other component face'; end if;
  if not exists(select 1 from jsonb_array_elements(result->'components') c where c->>'component_family_id'='face-back' and c->>'cut_side'='non-pattern') then raise exception 'Version response lost cutting side'; end if;
  if (select cut_side from public.cnc_components where id='face-front')<>'pattern' then raise exception 'Historical cutting side changed'; end if;
  result := public.update_item_version(auth.uid(),original_id,'cut_side','{"id":"face-front","cutSide":"either","expectedCutSide":"pattern"}');
  if result->>'changed'<>'false' or (result->'current'->>'id')::uuid<>next_id then raise exception 'Retry created another revision'; end if;
end $$;
select pg_temp.expect_face_error($q$select public.update_item_version(auth.uid(),'93000000-0000-4000-8000-000000000001','cut_side','{"id":"face-front","cutSide":"non-pattern","expectedCutSide":"pattern"}')$q$,'ITEM_VERSION_CONFLICT');
set local role service_role;
select public.update_item_version('00000000-0000-4000-8000-000000000009','93000000-0000-4000-8000-000000000001','replace_component',jsonb_build_object('id','face-back','expectedSha256',encode(sha256('ORIGINAL BACK'::bytea),'hex'),'expectedMaterialVariants',null,'expectedDxf',null,'component','{"gcode":"REPLACED BACK","width":50,"height":50,"bounding_box":{},"original_bounds":{},"metadata":{}}'::jsonb)) is not null;
reset role;
do $$ begin
  if not exists(select 1 from public.cnc_components c join public.marketplace_items i on i.id=c.item_id where i.version_default and i.version_family_id='93000000-0000-4000-8000-000000000001' and c.component_family_id='face-back' and c.cut_side='non-pattern' and c.gcode='REPLACED BACK') then raise exception 'Program replacement lost cutting side'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.aal','aal1',true);
select pg_temp.expect_face_error($q$select public.update_item_version(auth.uid(),'93000000-0000-4000-8000-000000000001','cut_side','{"id":"face-back","cutSide":"either","expectedCutSide":"non-pattern"}')$q$,'ITEM_VERSION_FORBIDDEN');
reset role;
rollback;
