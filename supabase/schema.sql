create table if not exists public.marketplace_items (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.marketplace_items
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;

create table if not exists public.cnc_components (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null references public.marketplace_items(id) on delete cascade,
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

create table if not exists public.sheet_projects (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  sheet jsonb not null,
  selected_item_id uuid references public.marketplace_items(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.sheet_projects
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;

alter table public.marketplace_items enable row level security;
alter table public.cnc_components enable row level security;
alter table public.sheet_projects enable row level security;

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
drop policy if exists "owner sheet read" on public.sheet_projects;
drop policy if exists "owner sheet write" on public.sheet_projects;

create policy "owner marketplace item read"
  on public.marketplace_items for select
  using (auth.uid() = owner_id);

create policy "owner marketplace item write"
  on public.marketplace_items for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "owner component read"
  on public.cnc_components for select
  using (auth.uid() = owner_id);

create policy "owner component write"
  on public.cnc_components for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "owner sheet read"
  on public.sheet_projects for select
  using (auth.uid() = owner_id);

create policy "owner sheet write"
  on public.sheet_projects for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);
