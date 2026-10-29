begin;

create table if not exists public.marketplace_items (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  uploaded_by text not null default '',
  sku text not null default '',
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.marketplace_items
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;

alter table public.marketplace_items
  add column if not exists sku text not null default '';

alter table public.marketplace_items
  add column if not exists uploaded_by text not null default '';

alter table public.marketplace_items
  add column if not exists packing jsonb not null default '{}';

alter table public.marketplace_items
  add column if not exists image jsonb;

alter table public.marketplace_items drop constraint if exists marketplace_item_image_valid;
alter table public.marketplace_items add constraint marketplace_item_image_valid check (
  image is null or (
    jsonb_typeof(image) = 'object' and image ? 'contentType' and image ? 'dataBase64'
    and (image - 'contentType' - 'dataBase64') = '{}'::jsonb
    and jsonb_typeof(image->'contentType') = 'string'
    and image->>'contentType' in ('image/jpeg', 'image/png')
    and jsonb_typeof(image->'dataBase64') = 'string'
    and length(image->>'dataBase64') between 4 and 699052
    and image->>'dataBase64' ~ '^[A-Za-z0-9+/]+={0,2}$'
  )
);

update public.marketplace_items
set sku = upper(regexp_replace(coalesce(nullif(name, ''), 'ITEM'), '[^a-zA-Z0-9]+', '-', 'g')) || '-' || upper(left(replace(id::text, '-', ''), 6))
where sku = '';

create table if not exists public.cnc_components (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null references public.marketplace_items(id) on delete cascade,
  sku text not null default '',
  name text not null,
  original_filename text not null,
  gcode text not null,
  dxf text,
  width double precision not null,
  height double precision not null,
  bounding_box jsonb not null,
  original_bounds jsonb not null,
  metadata jsonb not null,
  date_imported timestamptz not null default now()
);

alter table public.cnc_components
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;

alter table public.cnc_components
  add column if not exists sku text not null default '';

alter table public.cnc_components
  add column if not exists material_variants jsonb;

alter table public.cnc_components
  add column if not exists cut_side text not null default 'either';
alter table public.cnc_components drop constraint if exists component_cut_side_valid;
alter table public.cnc_components add constraint component_cut_side_valid check (cut_side in ('either', 'pattern', 'non-pattern'));

-- Old open tabs still send whole-catalogue upserts. Protect corrected programs
-- server-side as well as in the new client; API replacements use a guarded RPC.
create or replace function public.protect_component_program()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') and
    row(new.gcode, new.dxf, new.material_variants, new.width, new.height, new.bounding_box, new.original_bounds)
    is distinct from
    row(old.gcode, old.dxf, old.material_variants, old.width, old.height, old.bounding_box, old.original_bounds)
  then
    raise exception 'Component program conflict: an existing machining program cannot be overwritten by browser autosave. Export Project to back up your layout, then reload to use the current components.' using errcode = '40001';
  end if;
  return new;
end $$;
revoke all on function public.protect_component_program() from public, anon, authenticated;
drop trigger if exists protect_component_program on public.cnc_components;
create trigger protect_component_program before update on public.cnc_components
  for each row execute function public.protect_component_program();

update public.cnc_components component
set sku = item.sku || '-C' || upper(right(regexp_replace(component.id, '[^a-zA-Z0-9]+', '', 'g'), 6))
from public.marketplace_items item
where component.item_id = item.id
  and component.sku = '';

create table if not exists public.sheet_projects (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  sheet jsonb not null,
  selected_item_id uuid references public.marketplace_items(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.sheet_projects
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;

create table if not exists public.sheet_history (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  saved_at timestamptz not null default now(),
  sheet jsonb not null,
  selected_item_id uuid references public.marketplace_items(id) on delete set null,
  item_count integer not null default 0,
  component_count integer not null default 0,
  placed_count integer not null default 0
);

alter table public.sheet_history
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;

create table if not exists public.gcode_presets (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  uploaded_by text not null default '',
  name text not null,
  settings jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.marketplace_items enable row level security;
alter table public.cnc_components enable row level security;
alter table public.sheet_projects enable row level security;
alter table public.sheet_history enable row level security;
alter table public.gcode_presets enable row level security;

drop policy if exists "public marketplace item read" on public.marketplace_items;
drop policy if exists "public marketplace item write" on public.marketplace_items;
drop policy if exists "public component read" on public.cnc_components;
drop policy if exists "public component write" on public.cnc_components;
drop policy if exists "public sheet read" on public.sheet_projects;
drop policy if exists "public sheet write" on public.sheet_projects;
drop policy if exists "owner marketplace item read" on public.marketplace_items;
drop policy if exists "owner marketplace item write" on public.marketplace_items;
drop policy if exists "owner component read" on public.cnc_components;
drop policy if exists "owner component write" on public.cnc_components;
drop policy if exists "authenticated marketplace item read" on public.marketplace_items;
drop policy if exists "authenticated marketplace item write" on public.marketplace_items;
drop policy if exists "authenticated marketplace item insert" on public.marketplace_items;
drop policy if exists "owner marketplace item update" on public.marketplace_items;
drop policy if exists "owner marketplace item delete" on public.marketplace_items;
drop policy if exists "authenticated component read" on public.cnc_components;
drop policy if exists "authenticated component write" on public.cnc_components;
drop policy if exists "authenticated component insert" on public.cnc_components;
drop policy if exists "owner component update" on public.cnc_components;
drop policy if exists "owner component delete" on public.cnc_components;
drop policy if exists "owner sheet read" on public.sheet_projects;
drop policy if exists "owner sheet write" on public.sheet_projects;
drop policy if exists "owner sheet history read" on public.sheet_history;
drop policy if exists "owner sheet history write" on public.sheet_history;
drop policy if exists "authenticated sheet history read" on public.sheet_history;
drop policy if exists "authenticated gcode preset read" on public.gcode_presets;
drop policy if exists "authenticated gcode preset insert" on public.gcode_presets;
drop policy if exists "owner gcode preset update" on public.gcode_presets;
drop policy if exists "owner gcode preset delete" on public.gcode_presets;

create policy "authenticated marketplace item read"
  on public.marketplace_items for select
  using (auth.uid() is not null);

create policy "authenticated marketplace item insert"
  on public.marketplace_items for insert
  with check (auth.uid() is not null and owner_id = auth.uid());

create policy "owner marketplace item update"
  on public.marketplace_items for update
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

create policy "owner marketplace item delete"
  on public.marketplace_items for delete
  using (auth.uid() is not null);

create policy "authenticated component read"
  on public.cnc_components for select
  using (auth.uid() is not null);

create policy "authenticated component insert"
  on public.cnc_components for insert
  with check (auth.uid() is not null and owner_id = auth.uid());

create policy "owner component update"
  on public.cnc_components for update
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

create policy "owner component delete"
  on public.cnc_components for delete
  using (auth.uid() is not null);

create policy "owner sheet read"
  on public.sheet_projects for select
  using (auth.uid() = owner_id);

create policy "owner sheet write"
  on public.sheet_projects for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "authenticated sheet history read"
  on public.sheet_history for select
  using (auth.uid() = owner_id);

create policy "owner sheet history write"
  on public.sheet_history for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "authenticated gcode preset read"
  on public.gcode_presets for select
  using (auth.uid() = owner_id);

create policy "authenticated gcode preset insert"
  on public.gcode_presets for insert
  with check (auth.uid() is not null and owner_id = auth.uid());

create policy "owner gcode preset update"
  on public.gcode_presets for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "owner gcode preset delete"
  on public.gcode_presets for delete
  using (auth.uid() = owner_id);

-- Restrictive guards also constrain any legacy permissive policies.
do $$
declare table_name text;
begin
  foreach table_name in array array['sheet_projects', 'sheet_history', 'gcode_presets']
  loop
    execute format('drop policy if exists "account isolation" on public.%I', table_name);
    execute format('create policy "account isolation" on public.%I as restrictive for all using (owner_id = auth.uid()) with check (owner_id = auth.uid())', table_name);
  end loop;
end $$;

-- Shared catalogue; restrictive guards defeat old public permissive policies.
drop policy if exists "account isolation" on public.marketplace_items;
drop policy if exists "account isolation" on public.cnc_components;
drop policy if exists "component item ownership" on public.cnc_components;
drop policy if exists "catalogue authentication" on public.marketplace_items;
drop policy if exists "catalogue authentication" on public.cnc_components;
create policy "catalogue authentication" on public.marketplace_items as restrictive for all
  using (auth.uid() is not null) with check (auth.uid() is not null);
create policy "catalogue authentication" on public.cnc_components as restrictive for all
  using (auth.uid() is not null) with check (auth.uid() is not null);

-- owner_id is creator attribution, never reassigned when a colleague edits.
create or replace function public.preserve_catalogue_creator()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.owner_id is distinct from old.owner_id then
    raise exception 'Catalogue creator cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.preserve_catalogue_creator() from public, anon, authenticated;
drop trigger if exists preserve_catalogue_creator on public.marketplace_items;
create trigger preserve_catalogue_creator before update on public.marketplace_items
  for each row execute function public.preserve_catalogue_creator();
drop trigger if exists preserve_catalogue_creator on public.cnc_components;
create trigger preserve_catalogue_creator before update on public.cnc_components
  for each row execute function public.preserve_catalogue_creator();

-- JSON bodies avoid URL-size limits for long descriptions / packing settings.
-- Security-invoker preserves authenticated RLS and keeps creator/image/programs intact.
create or replace function public.update_shared_item_metadata(p_id uuid, p_expected jsonb, p_next jsonb)
returns boolean language plpgsql set search_path = '' as $$
begin
  update public.marketplace_items
    set name = p_next->>'name', sku = p_next->>'sku', description = p_next->>'description',
      packing = p_next->'packing', updated_at = now()
    where id = p_id and jsonb_build_object('name', name, 'sku', sku, 'description', description, 'packing', packing) = p_expected;
  return found;
end $$;
revoke all on function public.update_shared_item_metadata(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.update_shared_item_metadata(uuid, jsonb, jsonb) to authenticated;

create table if not exists public.user_program_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  start_gcode text not null check (length(start_gcode) between 1 and 8000),
  spindle_start_gcode text not null check (length(spindle_start_gcode) between 0 and 8000),
  end_gcode text not null check (length(end_gcode) between 1 and 8000),
  updated_at timestamptz not null default now()
);
-- An empty block means no automatic spindle start; retain NOT NULL and size limits.
alter table public.user_program_settings drop constraint if exists user_program_settings_spindle_start_gcode_check;
alter table public.user_program_settings add constraint user_program_settings_spindle_start_gcode_check check (length(spindle_start_gcode) between 0 and 8000);
alter table public.user_program_settings enable row level security;
grant select, insert, update on public.user_program_settings to authenticated;
grant all on public.user_program_settings to service_role;
drop policy if exists "own program settings" on public.user_program_settings;
create policy "own program settings" on public.user_program_settings for all to authenticated
  using (owner_id = auth.uid() and (auth.jwt()->>'aal') = 'aal2')
  with check (owner_id = auth.uid() and (auth.jwt()->>'aal') = 'aal2');
drop policy if exists "program account isolation" on public.user_program_settings;
create policy "program account isolation" on public.user_program_settings as restrictive for all
  using (owner_id = auth.uid() and (auth.jwt()->>'aal') = 'aal2')
  with check (owner_id = auth.uid() and (auth.jwt()->>'aal') = 'aal2');

-- Preserve Dan's established machine programs without assigning them to other users.
insert into public.user_program_settings (owner_id, start_gcode, spindle_start_gcode, end_gcode)
select id, E'G21\nG17\nG90\nG94', 'S18000 M03', E'M05\nM30'
from auth.users where lower(email) = 'dan@dpmerron.co.uk'
on conflict (owner_id) do nothing;

create table if not exists public.box_stock (
  id uuid primary key default gen_random_uuid(),
  updated_by uuid references auth.users(id) on delete set null,
  name text not null check (length(name) between 1 and 100),
  length_mm integer not null check (length_mm between 10 and 1200),
  width_mm integer not null check (width_mm between 10 and 1200),
  height_mm integer not null check (height_mm between 10 and 1200),
  quantity integer not null default 0 check (quantity between 0 and 100000),
  details text not null default '' check (length(details) <= 500),
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  unique (length_mm, width_mm, height_mm)
);
alter table public.box_stock enable row level security;
revoke all on public.box_stock from anon, authenticated;
grant select on public.box_stock to authenticated;
grant all on public.box_stock to service_role;
drop policy if exists "shared box stock" on public.box_stock;
create policy "shared box stock" on public.box_stock for select to authenticated using (auth.uid() is not null and auth.jwt()->>'aal' = 'aal2');
drop policy if exists "box access guard" on public.box_stock;
create policy "box access guard" on public.box_stock as restrictive for all using (auth.uid() is not null and auth.jwt()->>'aal' = 'aal2') with check (false);

-- Shared workshop stock; repeated deployments never reset inventory counts.
insert into public.box_stock (name, length_mm, width_mm, height_mm, quantity, details)
select sizes.name, sizes.length_mm, 350, 400, 10,
  '0201 regular slotted carton; single wall; plain brown kraft; no hand holes. Internal dimensions.'
from (values ('105 x 35 x 40 cm', 1050), ('120 x 35 x 40 cm', 1200)) sizes(name, length_mm)
on conflict (length_mm, width_mm, height_mm) do nothing;

-- Immutable exported files/layouts are private even though the catalogue is shared.
create table if not exists public.cnc_machine_runs (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  order_number text not null,
  material text not null,
  thickness text not null,
  sheet_count integer not null check (sheet_count > 0),
  part_count integer not null check (part_count > 0),
  status text not null default 'waiting' check (status in ('waiting', 'cutting', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  snapshot jsonb not null check ((snapshot->>'version' = '1' and jsonb_typeof(snapshot->'files') = 'array') is true)
);
create index if not exists cnc_machine_runs_owner_created on public.cnc_machine_runs(owner_id, created_at desc);
alter table public.cnc_machine_runs enable row level security;
revoke all on public.cnc_machine_runs from anon, authenticated;
grant select, insert on public.cnc_machine_runs to authenticated;
grant update(status) on public.cnc_machine_runs to authenticated;
grant all on public.cnc_machine_runs to service_role;
drop policy if exists "own machine exports" on public.cnc_machine_runs;
create policy "own machine exports" on public.cnc_machine_runs for all to authenticated
  using (owner_id = auth.uid() and auth.jwt()->>'aal' = 'aal2')
  with check (owner_id = auth.uid() and auth.jwt()->>'aal' = 'aal2');
drop policy if exists "machine export account guard" on public.cnc_machine_runs;
create policy "machine export account guard" on public.cnc_machine_runs as restrictive for all
  using (owner_id = auth.uid() and auth.jwt()->>'aal' = 'aal2')
  with check (owner_id = auth.uid() and auth.jwt()->>'aal' = 'aal2');

create or replace function public.guard_machine_export()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'waiting' then raise exception 'New exports must wait to cut' using errcode = '23514'; end if;
  else
    if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
      raise exception 'Exported files and layouts cannot be changed' using errcode = '42501';
    end if;
    if new.status is distinct from old.status and not (
      (old.status = 'waiting' and new.status in ('cutting', 'cancelled')) or
      (old.status = 'cutting' and new.status in ('completed', 'cancelled'))
    ) then raise exception 'Invalid export status transition' using errcode = '23514'; end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_machine_export() from public, anon, authenticated;
drop trigger if exists guard_machine_export on public.cnc_machine_runs;
create trigger guard_machine_export before insert or update on public.cnc_machine_runs
  for each row execute function public.guard_machine_export();

-- Replacement requests refer to the exact part in an immutable machine export.
create table if not exists public.cnc_machine_recuts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source_run_id uuid not null references public.cnc_machine_runs(id) on delete cascade,
  sheet_index integer not null check (sheet_index >= 0),
  part_number text not null check (length(part_number) between 1 and 40),
  part_name text not null default '',
  job_name text not null default '',
  order_number text not null default '',
  material text not null default '',
  thickness text not null default '',
  status text not null default 'queued' check (status in ('queued', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cnc_machine_recuts_owner_created on public.cnc_machine_recuts(owner_id, created_at, id);
create unique index if not exists cnc_machine_recuts_pending_part
  on public.cnc_machine_recuts(owner_id, source_run_id, sheet_index, part_number) where status = 'queued';
alter table public.cnc_machine_recuts enable row level security;
revoke all on public.cnc_machine_recuts from anon, authenticated;
grant select on public.cnc_machine_recuts to authenticated;
grant insert(owner_id, source_run_id, sheet_index, part_number) on public.cnc_machine_recuts to authenticated;
grant update(status) on public.cnc_machine_recuts to authenticated;
grant all on public.cnc_machine_recuts to service_role;
drop policy if exists "own machine recuts" on public.cnc_machine_recuts;
create policy "own machine recuts" on public.cnc_machine_recuts for all to authenticated
  using (owner_id = auth.uid() and auth.jwt()->>'aal' = 'aal2')
  with check (owner_id = auth.uid() and auth.jwt()->>'aal' = 'aal2');
drop policy if exists "machine recut account guard" on public.cnc_machine_recuts;
create policy "machine recut account guard" on public.cnc_machine_recuts as restrictive for all
  using (owner_id = auth.uid() and auth.jwt()->>'aal' = 'aal2')
  with check (owner_id = auth.uid() and auth.jwt()->>'aal' = 'aal2');

create or replace function public.guard_machine_recut()
returns trigger language plpgsql set search_path = '' as $$
declare
  source public.cnc_machine_runs;
  source_part jsonb;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'queued' then raise exception 'New re-cuts must be queued' using errcode = '23514'; end if;
    select * into source from public.cnc_machine_runs where id = new.source_run_id and owner_id = new.owner_id;
    if not found then raise exception 'Source export is not available in this account' using errcode = '42501'; end if;
    select part into source_part from jsonb_array_elements(coalesce(source.snapshot#>'{map,parts}', '[]'::jsonb)) part
      where part->>'number' = new.part_number and part->>'sheetIndex' = new.sheet_index::text;
    if source_part is null then raise exception 'The selected part is not on this exported sheet' using errcode = '23514'; end if;
    new.part_name := coalesce(nullif(source_part->>'name', ''), 'Unnamed part');
    new.job_name := source.name;
    new.order_number := source.order_number;
    new.material := source.material;
    new.thickness := source.thickness;
    new.created_at := now();
    new.updated_at := new.created_at;
  else
    if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
      raise exception 'Re-cut source and part details cannot be changed' using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
      if old.status <> 'queued' or new.status not in ('completed', 'cancelled') then
        raise exception 'Invalid re-cut status transition' using errcode = '23514';
      end if;
      new.updated_at := now();
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_machine_recut() from public, anon, authenticated;
drop trigger if exists guard_machine_recut on public.cnc_machine_recuts;
create trigger guard_machine_recut before insert or update on public.cnc_machine_recuts
  for each row execute function public.guard_machine_recut();

commit;

-- Editable production plans share the existing account-scoped, automatically saved project.
alter table public.sheet_projects add column if not exists workspace jsonb;

-- One daily sequence across all operators and exports, using the workshop's local date.
create table if not exists public.cnc_job_daily_numbers (
  job_date date primary key,
  last_number integer not null check (last_number > 0)
);
create table if not exists public.cnc_job_names (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  job_date date not null,
  job_number integer not null check (job_number > 0),
  unique (job_date, job_number)
);
alter table public.cnc_job_daily_numbers enable row level security;
alter table public.cnc_job_names enable row level security;
revoke all on public.cnc_job_daily_numbers, public.cnc_job_names from public, anon, authenticated;

create or replace function public.reserve_cnc_job_name(p_id uuid, p_owner uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  entry public.cnc_job_names;
  workshop_date date := (clock_timestamp() at time zone 'Europe/London')::date;
  next_number integer;
begin
  if p_id is null or p_owner is null or (current_setting('role',true) <> 'service_role' and
    (auth.uid() is distinct from p_owner or coalesce(auth.jwt()->>'aal','') <> 'aal2'))
  then raise exception 'JOB_NAME_FORBIDDEN' using errcode = '42501'; end if;
  -- Lost responses and simultaneous retries of the same job keep its original name.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 0));
  select * into entry from public.cnc_job_names where id = p_id;
  if found then
    if entry.owner_id <> p_owner then raise exception 'JOB_NAME_FORBIDDEN' using errcode = '42501'; end if;
  else
    insert into public.cnc_job_daily_numbers(job_date, last_number) values (workshop_date, 1)
      on conflict (job_date) do update set last_number = public.cnc_job_daily_numbers.last_number + 1
      returning last_number into next_number;
    insert into public.cnc_job_names(id, owner_id, job_date, job_number)
      values (p_id, p_owner, workshop_date, next_number) returning * into entry;
  end if;
  return entry.job_date::text || '-' || lpad(entry.job_number::text, greatest(3, length(entry.job_number::text)), '0');
end $$;
revoke all on function public.reserve_cnc_job_name(uuid, uuid) from public, anon;
grant execute on function public.reserve_cnc_job_name(uuid, uuid) to authenticated, service_role;

-- Old autosaves must not return material already at the machine to the planning pool.
create or replace function public.cnc_fixed_sheet(p_sheet jsonb, p_index integer)
returns jsonb language sql immutable set search_path = '' as $$
  select (p_sheet - array['name','instances','orderImports','orderNumber','nextPartNumber','unavailableSheetIndices']) ||
    jsonb_build_object('instances', coalesce((select jsonb_agg(value - array['locked','orderName'] order by ordinal)
      from jsonb_array_elements(p_sheet->'instances') with ordinality as instance(value, ordinal)
      where (value->>'sheetIndex')::integer = p_index), '[]'::jsonb))
$$;
create or replace function public.guard_cutting_workspace()
returns trigger language plpgsql set search_path = '' as $$
declare old_job jsonb; new_job jsonb; state record;
begin
  if new.workspace is distinct from old.workspace and new.workspace_version <> old.workspace_version + 1 then raise exception 'This cutting plan changed on another device. Reload the saved plan before continuing.' using errcode = '40001'; end if;
  for old_job in select value from jsonb_array_elements(old.workspace->'jobs') loop
    for state in select key, value from jsonb_each(old_job->'sheets') where value->>'stage' in ('cutting','cut') loop
      select value into new_job from jsonb_array_elements(new.workspace->'jobs') where value->>'id' = old_job->>'id';
      if new_job is null or coalesce(new_job->'sheets'->state.key->>'stage','waiting') not in ('cutting','cut')
        or (state.value->>'stage' = 'cut' and new_job->'sheets'->state.key->>'stage' <> 'cut')
        or public.cnc_fixed_sheet(old_job->'sheet', state.key::integer) is distinct from public.cnc_fixed_sheet(new_job->'sheet', state.key::integer)
      then raise exception 'A sheet is already cutting or cut. Reload the saved plan before continuing.' using errcode = '23514'; end if;
    end loop;
  end loop;
  return new;
end $$;
revoke all on function public.cnc_fixed_sheet(jsonb,integer), public.guard_cutting_workspace() from public, anon;
grant execute on function public.cnc_fixed_sheet(jsonb,integer) to authenticated, service_role;
drop trigger if exists guard_cutting_workspace on public.sheet_projects;
create trigger guard_cutting_workspace before update on public.sheet_projects for each row execute function public.guard_cutting_workspace();

alter table public.sheet_projects add column if not exists workspace_version integer not null default 0;
create or replace function public.save_cnc_workspace(p_owner uuid, p_workspace jsonb, p_sheet jsonb, p_selected_item_id uuid, p_expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare owner uuid := auth.uid(); current_plan public.sheet_projects; next_version integer;
begin
  if owner is null or owner is distinct from p_owner or coalesce(auth.jwt()->>'aal','') <> 'aal2' then raise exception 'WORKSPACE_FORBIDDEN' using errcode = '42501'; end if;
  if p_workspace is null or jsonb_typeof(p_workspace->'jobs') is distinct from 'array' or p_sheet is null or p_expected_version is null then raise exception 'Invalid cutting workspace'; end if;
  perform pg_advisory_xact_lock(hashtextextended('workspace:' || owner::text, 0));
  select * into current_plan from public.sheet_projects where id = owner::text and owner_id = owner for update;
  if found then
    if current_plan.workspace = p_workspace and current_plan.sheet = p_sheet and current_plan.selected_item_id is not distinct from p_selected_item_id then return current_plan.workspace_version; end if;
    if current_plan.workspace_version <> p_expected_version then raise exception 'This cutting plan changed on another device. Reload the saved plan before continuing.' using errcode = '40001'; end if;
    next_version := current_plan.workspace_version + 1;
    update public.sheet_projects set workspace = p_workspace, sheet = p_sheet, selected_item_id = p_selected_item_id, workspace_version = next_version, updated_at = now() where id = owner::text and owner_id = owner;
  else
    if p_expected_version <> 0 then raise exception 'The saved cutting plan is missing. Reload before continuing.'; end if;
    next_version := 1;
    insert into public.sheet_projects(id, owner_id, sheet, selected_item_id, workspace, workspace_version) values (owner::text, owner, p_sheet, p_selected_item_id, p_workspace, next_version);
  end if;
  return next_version;
end $$;
revoke all on function public.save_cnc_workspace(uuid,jsonb,jsonb,uuid,integer) from public, anon;
grant execute on function public.save_cnc_workspace(uuid,jsonb,jsonb,uuid,integer) to authenticated;
