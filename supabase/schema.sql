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

commit;
