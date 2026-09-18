begin;
grant usage on schema public to authenticated, anon;
grant select, insert, update, delete on all tables in schema public to authenticated, anon;
insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');

-- A forgotten permissive legacy policy must not defeat the restrictive guard.
create policy "test legacy shared read" on public.marketplace_items for select using (true);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
insert into public.marketplace_items (id, owner_id, name) values
  ('10000000-0000-4000-8000-000000000001', auth.uid(), 'Account A item');
update public.marketplace_items set image = '{"contentType":"image/png","dataBase64":"YWJjZA=="}' where id = '10000000-0000-4000-8000-000000000001';
do $$
begin
  begin
    update public.marketplace_items set image = '{"contentType":"image/svg+xml","dataBase64":"YWJjZA=="}';
    raise exception 'Active image type allowed';
  exception when check_violation then null;
  end;
  begin
    update public.marketplace_items set image = jsonb_build_object('contentType', 'image/png', 'dataBase64', repeat('a', 699056));
    raise exception 'Oversized image allowed';
  exception when check_violation then null;
  end;
  begin
    update public.marketplace_items set image = '{"contentType":null,"dataBase64":"YWJjZA=="}';
    raise exception 'Null image MIME allowed';
  exception when check_violation then null;
  end;
end $$;
insert into public.cnc_components (id, owner_id, item_id, name, original_filename, gcode, width, height, bounding_box, original_bounds, metadata)
  values ('account-a-part', auth.uid(), '10000000-0000-4000-8000-000000000001', 'Part A', 'a.nc', 'G21', 1, 1, '{}', '{}', '{}');
insert into public.sheet_projects (id, owner_id, sheet) values ('account-a-sheet', auth.uid(), '{}');
insert into public.sheet_history (id, owner_id, name, sheet) values ('account-a-history', auth.uid(), 'A', '{}');
insert into public.gcode_presets (id, owner_id, name, settings) values ('account-a-preset', auth.uid(), 'A', '{}');

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
do $$
declare table_name text; visible_count integer; affected integer;
begin
  foreach table_name in array array['marketplace_items', 'cnc_components', 'sheet_projects', 'sheet_history', 'gcode_presets'] loop
    execute format('select count(*) from public.%I', table_name) into visible_count;
    if visible_count <> 0 then raise exception 'Account B can read account A: %', table_name; end if;
    execute format('delete from public.%I', table_name);
    get diagnostics affected = row_count;
    if affected <> 0 then raise exception 'Account B can delete account A: %', table_name; end if;
  end loop;

  update public.marketplace_items set name = 'Hijacked' where id = '10000000-0000-4000-8000-000000000001';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Foreign item update allowed'; end if;
  update public.marketplace_items set image = null where id = '10000000-0000-4000-8000-000000000001';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Foreign item image removal allowed'; end if;

  begin
    insert into public.marketplace_items (id, owner_id, name)
      values ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'Spoofed owner');
    raise exception 'Owner spoof allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.cnc_components (id, owner_id, item_id, name, original_filename, gcode, width, height, bounding_box, original_bounds, metadata)
      values ('foreign-parent-part', auth.uid(), '10000000-0000-4000-8000-000000000001', 'B', 'b.nc', 'G21', 1, 1, '{}', '{}', '{}');
    raise exception 'Foreign parent allowed';
  exception when insufficient_privilege then null;
  end;
end $$;

insert into public.marketplace_items (id, owner_id, name) values
  ('10000000-0000-4000-8000-000000000002', auth.uid(), 'Account B item');
insert into public.cnc_components (id, owner_id, item_id, name, original_filename, gcode, width, height, bounding_box, original_bounds, metadata)
  values ('account-b-part', auth.uid(), '10000000-0000-4000-8000-000000000002', 'Part B', 'b.nc', 'G21', 1, 1, '{}', '{}', '{}');
do $$
begin
  if (select count(*) from public.cnc_components) <> 1 then raise exception 'Own component not visible'; end if;
  begin
    update public.cnc_components set item_id = '10000000-0000-4000-8000-000000000001' where id = 'account-b-part';
    raise exception 'Foreign reparenting allowed';
  exception when insufficient_privilege then null;
  end;
end $$;

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$
declare table_name text; visible_count integer;
begin
  if (select image->>'contentType' from public.marketplace_items where id = '10000000-0000-4000-8000-000000000001') is distinct from 'image/png' then raise exception 'Owner image was lost'; end if;
  foreach table_name in array array['marketplace_items', 'cnc_components', 'sheet_projects', 'sheet_history', 'gcode_presets'] loop
    execute format('select count(*) from public.%I', table_name) into visible_count;
    if visible_count <> 1 then raise exception 'Account A ownership failed: %', table_name; end if;
  end loop;
end $$;

set local role anon;
set local request.jwt.claim.sub = '';
do $$
declare table_name text; visible_count integer;
begin
  foreach table_name in array array['marketplace_items', 'cnc_components', 'sheet_projects', 'sheet_history', 'gcode_presets'] loop
    execute format('select count(*) from public.%I', table_name) into visible_count;
    if visible_count <> 0 then raise exception 'Anonymous access allowed: %', table_name; end if;
  end loop;
end $$;
rollback;
