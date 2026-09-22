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
insert into public.cnc_components (id, owner_id, item_id, name, original_filename, gcode, width, height, bounding_box, original_bounds, metadata, material_variants)
  values ('account-a-part', auth.uid(), '10000000-0000-4000-8000-000000000001', 'Part A', 'a.nc', 'G21', 1, 1, '{}', '{}', '{}', '{"version":1,"profiles":{"6":{"gcode":"G21"}}}');
insert into public.sheet_projects (id, owner_id, sheet) values ('account-a-sheet', auth.uid(), '{}');
-- Older clients write metadata without knowing about the separate variants column.
update public.cnc_components set metadata = '{"warnings":[]}' where id = 'account-a-part';
insert into public.sheet_history (id, owner_id, name, sheet) values ('account-a-history', auth.uid(), 'A', '{}');
insert into public.gcode_presets (id, owner_id, name, settings) values ('account-a-preset', auth.uid(), 'A', '{}');

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
do $$
declare table_name text; visible_count integer; affected integer;
begin
  foreach table_name in array array['sheet_projects', 'sheet_history', 'gcode_presets'] loop
    execute format('select count(*) from public.%I', table_name) into visible_count;
    if visible_count <> 0 then raise exception 'Account B can read account A private data: %', table_name; end if;
    execute format('delete from public.%I', table_name);
    get diagnostics affected = row_count;
    if affected <> 0 then raise exception 'Account B can delete account A private data: %', table_name; end if;
  end loop;
  if (select count(*) from public.marketplace_items) <> 1 then raise exception 'Shared item missing'; end if;
  if (select count(*) from public.cnc_components) <> 1 then raise exception 'Shared component missing'; end if;
  if (select image->>'contentType' from public.marketplace_items limit 1) <> 'image/png' then raise exception 'Shared image missing'; end if;
  if not public.update_shared_item_metadata('10000000-0000-4000-8000-000000000001',
    '{"name":"Account A item","sku":"","description":"","packing":{}}',
    '{"name":"Shared edit","sku":"SKU","description":"Shared details","packing":{}}') then raise exception 'Shared metadata save failed'; end if;
  if public.update_shared_item_metadata('10000000-0000-4000-8000-000000000001',
    '{"name":"Account A item","sku":"","description":"","packing":{}}',
    '{"name":"Stale edit","sku":"SKU","description":"Wrong","packing":{}}') then raise exception 'Stale metadata save succeeded'; end if;
  update public.marketplace_items set name = 'Edited by B', image = null where id = '10000000-0000-4000-8000-000000000001';
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'Shared item update failed'; end if;
  update public.cnc_components set name = 'Edited part' where id = 'account-a-part';
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'Shared component update failed'; end if;
  begin
    update public.cnc_components set material_variants = null where id = 'account-a-part';
    raise exception 'Browser program overwrite allowed';
  exception when serialization_failure then null;
  end;
  begin
    update public.marketplace_items set owner_id = auth.uid();
    raise exception 'Creator reassignment allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.cnc_components set owner_id = auth.uid();
    raise exception 'Component creator reassignment allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.marketplace_items (id, owner_id, name)
      values ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'Spoofed owner');
    raise exception 'Creator spoof allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
-- B adds a component to A's shared item; each retains its creator.
insert into public.cnc_components (id, owner_id, item_id, name, original_filename, gcode, width, height, bounding_box, original_bounds, metadata)
values ('account-b-part', auth.uid(), '10000000-0000-4000-8000-000000000001', 'B', 'b.nc', 'G21', 1, 1, '{}', '{}', '{}');
insert into public.sheet_projects(id, owner_id, selected_item_id, sheet)
values ('account-b-sheet', auth.uid(), '10000000-0000-4000-8000-000000000001', '{"instances":[{"partId":"account-a-part"}]}');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$
begin
  if (select name from public.marketplace_items limit 1) <> 'Edited by B' then raise exception 'Shared edit not visible'; end if;
  if (select count(*) from public.cnc_components) <> 2 then raise exception 'Shared component not visible'; end if;
  if (select owner_id from public.marketplace_items limit 1) <> auth.uid() then raise exception 'Original creator lost'; end if;
  if (select count(*) from public.sheet_projects) <> 1 then raise exception 'Sheets became shared'; end if;
  if (select material_variants #>> '{profiles,6,gcode}' from public.cnc_components where id = 'account-a-part') <> 'G21' then raise exception 'Programs lost'; end if;
  delete from public.cnc_components where id = 'account-b-part';
  if (select count(*) from public.cnc_components) <> 1 then raise exception 'Shared component deletion failed'; end if;
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
