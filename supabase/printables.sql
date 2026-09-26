-- Shared STL library; files remain private to MFA-authenticated app users.
create table if not exists public.printable_assets (
  id uuid primary key,
  owner_id uuid not null references auth.users(id),
  name text not null check (length(btrim(name)) between 1 and 120),
  purpose text not null check (purpose in ('product', 'packaging')),
  item_id uuid references public.marketplace_items(id) on delete set null,
  notes text not null default '' check (length(notes) <= 4000),
  units text not null check (units in ('mm', 'inches')),
  filename text not null check (length(filename) between 5 and 240 and filename ~* '\.stl$' and filename !~ '[/\\]'),
  file_bytes integer not null check (file_bytes between 1 and 26214400),
  triangles integer not null check (triangles between 1 and 500000),
  dimensions double precision[] not null check (array_length(dimensions, 1) = 3 and array_ndims(dimensions) = 1 and array_position(dimensions, null) is null and 0 <= all(dimensions) and 20000000 >= all(dimensions) and 0 < any(dimensions)),
  stl_path text generated always as (owner_id::text || '/' || id::text || '/model.stl') stored,
  preview_path text generated always as (owner_id::text || '/' || id::text || '/preview.png') stored,
  created_at timestamptz not null default now()
);
create index if not exists printable_assets_created_idx on public.printable_assets(created_at desc, id);
create index if not exists printable_assets_item_idx on public.printable_assets(item_id);
alter table public.printable_assets enable row level security;
revoke all on public.printable_assets from anon, authenticated;
grant select, insert, delete on public.printable_assets to authenticated;
grant all on public.printable_assets to service_role;

-- Read-only lookup avoids a recursive asset -> object -> asset RLS dependency.
create or replace function public.printable_file_published(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and auth.jwt()->>'aal' = 'aal2'
    and exists (select 1 from public.printable_assets p where p_path in (p.stl_path, p.preview_path))
$$;
revoke all on function public.printable_file_published(text) from public, anon;
grant execute on function public.printable_file_published(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cnc-printables', 'cnc-printables', false, 26214400, array['model/stl','image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists printable_assets_read on public.printable_assets;
create policy printable_assets_read on public.printable_assets for select to authenticated using ((select auth.jwt()->>'aal') = 'aal2');
drop policy if exists printable_assets_insert on public.printable_assets;
create policy printable_assets_insert on public.printable_assets for insert to authenticated with check (
  owner_id = (select auth.uid()) and (select auth.jwt()->>'aal') = 'aal2'
  and exists (select 1 from storage.objects o where o.bucket_id = 'cnc-printables' and o.name = printable_assets.owner_id::text || '/' || printable_assets.id::text || '/model.stl')
  and exists (select 1 from storage.objects o where o.bucket_id = 'cnc-printables' and o.name = printable_assets.owner_id::text || '/' || printable_assets.id::text || '/preview.png')
);
drop policy if exists printable_assets_delete on public.printable_assets;
create policy printable_assets_delete on public.printable_assets for delete to authenticated using (owner_id = (select auth.uid()) and (select auth.jwt()->>'aal') = 'aal2');

drop policy if exists printable_files_read on storage.objects;
create policy printable_files_read on storage.objects for select to authenticated using (
  bucket_id = 'cnc-printables' and (select auth.jwt()->>'aal') = 'aal2' and (
    split_part(name, '/', 1) = (select auth.uid())::text
    or public.printable_file_published(name)
  )
);
drop policy if exists printable_files_insert on storage.objects;
create policy printable_files_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'cnc-printables' and (select auth.jwt()->>'aal') = 'aal2'
  and split_part(name, '/', 1) = (select auth.uid())::text
  and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/(model\.stl|preview\.png)$'
);
drop policy if exists printable_files_delete on storage.objects;
create policy printable_files_delete on storage.objects for delete to authenticated using (
  bucket_id = 'cnc-printables' and (select auth.jwt()->>'aal') = 'aal2'
  and split_part(name, '/', 1) = (select auth.uid())::text
  and not public.printable_file_published(name)
);
-- No UPDATE policy: published STL bytes and previews cannot be overwritten.
