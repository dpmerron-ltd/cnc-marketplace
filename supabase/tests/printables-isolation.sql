begin;
insert into auth.users(id) values ('10000000-0000-4000-8000-000000000001'), ('10000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.aal','aal2',true);
insert into storage.objects(bucket_id,name) values
 ('cnc-printables','10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/model.stl'),
 ('cnc-printables','10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/preview.png'),
 ('cnc-printables','10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000002/model.stl');
insert into public.printable_assets(id,owner_id,name,purpose,units,filename,file_bytes,triangles,dimensions)
values ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Corner protector','packaging','mm','corner.stl',684,12,array[20,30,40]);
do $$ begin
  delete from storage.objects where name like '%20000000-0000-4000-8000-000000000001%';
  if found then raise exception 'Published files could be deleted before removing the library entry'; end if;
  begin
    insert into public.printable_assets(id,owner_id,name,purpose,units,filename,file_bytes,triangles,dimensions)
    values ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Missing image','product','mm','test.stl',684,12,array[20,30,40]);
    raise exception 'Row without both files accepted';
  exception when insufficient_privilege then null; end;
end $$;

-- Another MFA user can read all published entries and files, but not pending uploads.
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
do $$ begin
  if (select count(*) from public.printable_assets) <> 1 then raise exception 'Shared library not readable'; end if;
  if (select count(*) from storage.objects where bucket_id='cnc-printables') <> 2 then raise exception 'Shared downloads or pending-file isolation failed'; end if;
  delete from public.printable_assets;
  if found then raise exception 'Other uploader entry deleted'; end if;
  delete from storage.objects where bucket_id='cnc-printables';
  if found then raise exception 'Other uploader files deleted'; end if;
  update storage.objects set name='changed.stl' where bucket_id='cnc-printables';
  if found then raise exception 'STL overwritten'; end if;
  begin
    insert into storage.objects(bucket_id,name) values ('cnc-printables','10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000003/model.stl');
    raise exception 'Upload impersonation accepted';
  exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claim.aal','aal1',true);
do $$ begin
  if exists(select 1 from public.printable_assets) or exists(select 1 from storage.objects where bucket_id='cnc-printables') then raise exception 'MFA bypass allowed'; end if;
  begin
    insert into storage.objects(bucket_id,name) values ('cnc-printables','10000000-0000-4000-8000-000000000002/20000000-0000-4000-8000-000000000004/model.stl');
    raise exception 'AAL1 upload accepted';
  exception when insufficient_privilege then null; end;
end $$;
set local role anon;
do $$ begin
  if exists(select 1 from storage.objects where bucket_id='cnc-printables') then raise exception 'Anonymous file access'; end if;
  begin perform 1 from public.printable_assets; raise exception 'Anonymous catalogue access'; exception when insufficient_privilege then null; end;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.aal','aal2',true);
delete from public.printable_assets where id='20000000-0000-4000-8000-000000000001';
delete from storage.objects where bucket_id='cnc-printables';
do $$ begin if exists(select 1 from storage.objects where bucket_id='cnc-printables') then raise exception 'Uploader cleanup failed'; end if; end $$;
rollback;
