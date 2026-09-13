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

alter table public.marketplace_items enable row level security;
alter table public.cnc_components enable row level security;
alter table public.sheet_projects enable row level security;
alter table public.sheet_history enable row level security;

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

create policy "authenticated marketplace item read"
  on public.marketplace_items for select
  using (auth.uid() is not null);

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
  using (auth.uid() is not null);

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
  using (auth.uid() is not null);

create policy "owner sheet history write"
  on public.sheet_history for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
