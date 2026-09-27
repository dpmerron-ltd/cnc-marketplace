begin;
insert into auth.users(id) values ('10000000-0000-4000-8000-000000000001'), ('10000000-0000-4000-8000-000000000002');
insert into public.marketplace_items(id,owner_id,sku,name) values ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','DOC-1','Document test');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.aal','aal2',true);
insert into storage.objects(bucket_id,name) values
 ('cnc-item-documents','10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/document.pdf'),
 ('cnc-item-documents','10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000002/document.pdf');
insert into public.item_documents(id,item_id,owner_id,kind,filename,file_bytes,pages)
values ('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','instructions','instructions.pdf',1000,2);
do $$ begin
  delete from storage.objects where name like '%20000000-0000-4000-8000-000000000001%';
  if found then raise exception 'Published PDF deleted'; end if;
  begin
    insert into public.item_documents(id,item_id,owner_id,kind,filename,file_bytes,pages)
    values ('20000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','packing','missing.pdf',1000,1);
    raise exception 'Missing PDF accepted';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
do $$ begin
  if (select count(*) from public.item_documents) <> 1 then raise exception 'Shared documents not readable'; end if;
  if (select count(*) from storage.objects where bucket_id='cnc-item-documents') <> 1 then raise exception 'Pending files exposed or published PDF inaccessible'; end if;
  delete from public.item_documents;
  if found then raise exception 'Other uploader document deleted'; end if;
  delete from storage.objects where bucket_id='cnc-item-documents';
  if found then raise exception 'Other uploader PDF deleted'; end if;
  update storage.objects set name='changed.pdf' where bucket_id='cnc-item-documents';
  if found then raise exception 'PDF overwritten'; end if;
  begin
    insert into storage.objects(bucket_id,name) values ('cnc-item-documents','10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000004/document.pdf');
    raise exception 'Upload impersonation accepted';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.aal','aal1',true);
do $$ begin
  if exists(select 1 from public.item_documents) or exists(select 1 from storage.objects where bucket_id='cnc-item-documents') then raise exception 'MFA bypass'; end if;
end $$;
set local role anon;
do $$ begin
  if exists(select 1 from storage.objects where bucket_id='cnc-item-documents') then raise exception 'Anonymous file access'; end if;
  begin perform 1 from public.item_documents; raise exception 'Anonymous metadata access'; exception when insufficient_privilege then null; end;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.aal','aal2',true);
delete from public.item_documents;
delete from storage.objects where bucket_id='cnc-item-documents';
do $$ begin if exists(select 1 from storage.objects where bucket_id='cnc-item-documents') then raise exception 'Uploader cleanup failed'; end if; end $$;
rollback;
