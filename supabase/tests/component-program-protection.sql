begin;
grant usage on schema public to authenticated, service_role;
grant select, insert, update on public.marketplace_items, public.cnc_components to authenticated, service_role;
insert into auth.users (id) values ('00000000-0000-4000-8000-000000000071');
insert into public.marketplace_items (id, owner_id, name) values
  ('10000000-0000-4000-8000-000000000071', '00000000-0000-4000-8000-000000000071', 'Protected item');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000071';
set local request.jwt.claim.aal = 'aal2';
insert into public.cnc_components (id, owner_id, item_id, name, original_filename, gcode, dxf, width, height, bounding_box, original_bounds, metadata, material_variants)
values ('protected-part', auth.uid(), '10000000-0000-4000-8000-000000000071', 'Right side', 'side.nc', 'G21', 'DXF', 10, 20, '{}', '{}', '{}', '{"profiles":{"12":{"gcode":"G21"}}}');
-- Exact retries and descriptive metadata updates must continue to work.
insert into public.cnc_components (id, owner_id, item_id, name, original_filename, gcode, width, height, bounding_box, original_bounds, metadata)
values ('protected-part', auth.uid(), '10000000-0000-4000-8000-000000000071', 'Right side', 'side.nc', 'G21', 10, 20, '{}', '{}', '{}')
on conflict (id) do update set gcode = excluded.gcode;
update public.cnc_components set metadata = '{"warnings":[]}' where id = 'protected-part';
-- Only the revision-checked service RPC can replace an existing program.
set local role service_role;
select public.replace_cnc_component_gcode(
  '00000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', 'protected-part',
  encode(sha256('G21'::bytea), 'hex'), '{"profiles":{"12":{"gcode":"G21"}}}', 'DXF',
  'G21 G90', '{"profiles":{"12":{"gcode":"G21 G90"}}}', 10, 20, '{}', '{}', '{}'
);
set local role authenticated;
do $$
begin
  -- A stale pre-fix browser upsert must not undo the correction.
  begin
    insert into public.cnc_components (id, owner_id, item_id, name, original_filename, gcode, width, height, bounding_box, original_bounds, metadata)
    values ('protected-part', auth.uid(), '10000000-0000-4000-8000-000000000071', 'Right side', 'side.nc', 'G21', 10, 20, '{}', '{}', '{}')
    on conflict (id) do update set gcode = excluded.gcode;
    raise exception 'Stale program overwrite allowed';
  exception when serialization_failure then null;
  end;
  begin
    update public.cnc_components set material_variants = '{"profiles":{"12":{"gcode":"G21"}}}' where id = 'protected-part';
    raise exception 'Stale variant overwrite allowed';
  exception when serialization_failure then null;
  end;
  begin
    update public.cnc_components set material_variants = null where id = 'protected-part';
    raise exception 'Variant removal allowed';
  exception when serialization_failure then null;
  end;
  begin
    update public.cnc_components set dxf = 'Different source' where id = 'protected-part';
    raise exception 'Source replacement allowed';
  exception when serialization_failure then null;
  end;
  begin
    update public.cnc_components set width = 999 where id = 'protected-part';
    raise exception 'Stale geometry overwrite allowed';
  exception when serialization_failure then null;
  end;
  if (select gcode from public.cnc_components where id = 'protected-part') <> 'G21 G90' then raise exception 'Corrected program lost'; end if;
  if (select material_variants #>> '{profiles,12,gcode}' from public.cnc_components where id = 'protected-part') <> 'G21 G90' then raise exception 'Corrected variant lost'; end if;
end $$;
-- New autosaves insert genuinely new parts, but skip existing corrected IDs.
insert into public.cnc_components (id, owner_id, item_id, name, original_filename, gcode, width, height, bounding_box, original_bounds, metadata)
values ('protected-part', auth.uid(), '10000000-0000-4000-8000-000000000071', 'Right side', 'side.nc', 'G21', 10, 20, '{}', '{}', '{}'),
  ('new-part', auth.uid(), '10000000-0000-4000-8000-000000000071', 'New side', 'new.nc', 'G21', 10, 20, '{}', '{}', '{}')
on conflict (id) do nothing;
do $$
begin
  if (select count(*) from public.cnc_components) <> 2 then raise exception 'New import lost'; end if;
  if (select gcode from public.cnc_components where id = 'protected-part') <> 'G21 G90' then raise exception 'Insert-only autosave replaced corrected program'; end if;
end $$;
-- Correct source drawing and all programs atomically without changing identities.
set local role service_role;
select public.replace_cnc_component_source(
  '00000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', 'protected-part',
  encode(sha256('G21 G90'::bytea), 'hex'), '{"profiles":{"12":{"gcode":"G21 G90"}}}', 'DXF', 'DXF corrected',
  'G21 G90 G17', '{"profiles":{"12":{"gcode":"G21 G90 G17"}}}', 11, 21, '{}', '{}', '{}'
);
do $$
begin
  if (select dxf from public.cnc_components where id = 'protected-part') <> 'DXF corrected' then raise exception 'Corrected source missing'; end if;
  if (select name from public.cnc_components where id = 'protected-part') <> 'Right side' then raise exception 'Identity changed'; end if;
  if (select gcode from public.cnc_components where id = 'protected-part') <> 'G21 G90 G17' then raise exception 'Corrected NC missing'; end if;
  begin
    perform public.replace_cnc_component_source(
      '00000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000071', 'protected-part',
      encode(sha256('G21 G90 G17'::bytea), 'hex'), '{"profiles":{"12":{"gcode":"G21 G90 G17"}}}', 'stale DXF', 'WRONG',
      'G21 G90 G17', '{"profiles":{"12":{"gcode":"G21 G90 G17"}}}', 11, 21, '{}', '{}', '{}');
    raise exception 'Stale source update accepted';
  exception when raise_exception then
    if sqlerrm <> 'COMPONENT_REVISION_CONFLICT' then raise; end if;
  end;
  begin
    perform public.replace_cnc_component_source(
      '00000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000099', 'protected-part',
      encode(sha256('G21 G90 G17'::bytea), 'hex'), '{"profiles":{"12":{"gcode":"G21 G90 G17"}}}', 'DXF corrected', 'WRONG',
      'G21 G90 G17', '{"profiles":{"12":{"gcode":"G21 G90 G17"}}}', 11, 21, '{}', '{}', '{}');
    raise exception 'Wrong-item source update accepted';
  exception when raise_exception then
    if sqlerrm <> 'COMPONENT_NOT_FOUND' then raise; end if;
  end;
  if (select dxf from public.cnc_components where id = 'protected-part') <> 'DXF corrected' then raise exception 'Conflict mutated source'; end if;
end $$;
rollback;
