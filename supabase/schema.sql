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
  using (auth.uid() = owner_id);

create policy "authenticated marketplace item insert"
  on public.marketplace_items for insert
  with check (auth.uid() is not null and owner_id = auth.uid());

create policy "owner marketplace item update"
  on public.marketplace_items for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "owner marketplace item delete"
  on public.marketplace_items for delete
  using (auth.uid() = owner_id);

create policy "authenticated component read"
  on public.cnc_components for select
  using (auth.uid() = owner_id);

create policy "authenticated component insert"
  on public.cnc_components for insert
  with check (auth.uid() is not null and owner_id = auth.uid());

create policy "owner component update"
  on public.cnc_components for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "owner component delete"
  on public.cnc_components for delete
  using (auth.uid() = owner_id);

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
  foreach table_name in array array['marketplace_items', 'cnc_components', 'sheet_projects', 'sheet_history', 'gcode_presets']
  loop
    execute format('drop policy if exists "account isolation" on public.%I', table_name);
    execute format('create policy "account isolation" on public.%I as restrictive for all using (owner_id = auth.uid()) with check (owner_id = auth.uid())', table_name);
  end loop;
end $$;

drop policy if exists "component item ownership" on public.cnc_components;
create policy "component item ownership"
  on public.cnc_components as restrictive for all
  using (exists (select 1 from public.marketplace_items item where item.id = item_id and item.owner_id = auth.uid()))
  with check (exists (select 1 from public.marketplace_items item where item.id = item_id and item.owner_id = auth.uid()));

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

commit;
