-- Shared catalogue PDFs; authenticated downloads only, immutable published bytes.
begin;
create table if not exists public.item_documents (
  id uuid primary key,
  item_id uuid not null references public.marketplace_items(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  kind text not null check (kind in ('instructions', 'packing')),
  filename text not null check (length(filename) between 5 and 240 and filename ~* '\.pdf$' and filename !~ '[/\\]'),
  file_bytes integer not null check (file_bytes between 1 and 20971520),
  pages integer not null check (pages between 1 and 200),
  file_path text generated always as (owner_id::text || '/' || id::text || '/document.pdf') stored,
  created_at timestamptz not null default now()
);
create index if not exists item_documents_item_idx on public.item_documents(item_id, created_at, id);
alter table public.item_documents enable row level security;
revoke all on public.item_documents from anon, authenticated;
grant select, insert, delete on public.item_documents to authenticated;
grant all on public.item_documents to service_role;

create or replace function public.item_document_published(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and auth.jwt()->>'aal' = 'aal2'
    and exists (select 1 from public.item_documents d where d.file_path = p_path)
$$;
revoke all on function public.item_document_published(text) from public, anon;
grant execute on function public.item_document_published(text) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('cnc-item-documents', 'cnc-item-documents', false, 20971520, array['application/pdf'])
on conflict(id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists item_documents_read on public.item_documents;
create policy item_documents_read on public.item_documents for select to authenticated using ((select auth.jwt()->>'aal') = 'aal2');
drop policy if exists item_documents_insert on public.item_documents;
create policy item_documents_insert on public.item_documents for insert to authenticated with check (
  owner_id = (select auth.uid()) and (select auth.jwt()->>'aal') = 'aal2'
  and exists(select 1 from storage.objects o where o.bucket_id = 'cnc-item-documents' and o.name = item_documents.owner_id::text || '/' || item_documents.id::text || '/document.pdf')
);
drop policy if exists item_documents_delete on public.item_documents;
create policy item_documents_delete on public.item_documents for delete to authenticated using (owner_id = (select auth.uid()) and (select auth.jwt()->>'aal') = 'aal2');

drop policy if exists item_document_files_read on storage.objects;
create policy item_document_files_read on storage.objects for select to authenticated using (
  bucket_id = 'cnc-item-documents' and (select auth.jwt()->>'aal') = 'aal2'
  and (split_part(name, '/', 1) = (select auth.uid())::text or public.item_document_published(name))
);
drop policy if exists item_document_files_insert on storage.objects;
create policy item_document_files_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'cnc-item-documents' and (select auth.jwt()->>'aal') = 'aal2'
  and split_part(name, '/', 1) = (select auth.uid())::text
  and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/document\.pdf$'
);
drop policy if exists item_document_files_delete on storage.objects;
create policy item_document_files_delete on storage.objects for delete to authenticated using (
  bucket_id = 'cnc-item-documents' and (select auth.jwt()->>'aal') = 'aal2'
  and split_part(name, '/', 1) = (select auth.uid())::text and not public.item_document_published(name)
);
commit;
