begin;
insert into auth.users(id, email) values ('00000000-0000-4000-8000-000000000087', 'plans@example.com');
grant select, insert, update on public.sheet_projects to authenticated;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000087';
set local request.jwt.claim.aal = 'aal2';
insert into public.sheet_projects(id, owner_id, sheet, workspace) values (auth.uid(), auth.uid(), '{}',
'{"activeId":"job","jobs":[{"id":"job","sheet":{"width":1220,"height":1220,"instances":[{"id":"cut","partId":"panel","sheetIndex":0,"x":20},{"id":"waiting","partId":"panel","sheetIndex":1,"x":20}]},"sheets":{"0":{"stage":"cutting"},"1":{"stage":"waiting"}}}]}');
-- A waiting sheet can change while the first sheet is at the machine.
update public.sheet_projects set workspace_version = workspace_version + 1, workspace = jsonb_set(workspace, '{jobs,0,sheet,instances,1,x}', '100') where id = auth.uid()::text;
do $$ begin
  begin
    update public.sheet_projects set workspace_version = workspace_version + 1, workspace = jsonb_set(workspace, '{jobs,0,sheet,instances,0,x}', '100') where id = auth.uid()::text;
    raise exception 'Moving a cutting part was allowed';
  exception when check_violation then null; end;
  begin
    update public.sheet_projects set workspace_version = workspace_version + 1, workspace = jsonb_set(workspace, '{jobs,0,sheets,0,stage}', '"waiting"') where id = auth.uid()::text;
    raise exception 'Old autosave reopened a cutting sheet';
  exception when check_violation then null; end;
end $$;
update public.sheet_projects set workspace_version = workspace_version + 1, workspace = jsonb_set(workspace, '{jobs,0,sheets,0,stage}', '"cut"') where id = auth.uid()::text;
do $$ begin
  begin
    update public.sheet_projects set workspace_version = workspace_version + 1, workspace = jsonb_set(workspace, '{jobs,0,sheets,0,stage}', '"cutting"') where id = auth.uid()::text;
    raise exception 'Cut sheet was reopened';
  exception when check_violation then null; end;
  begin
    update public.sheet_projects set workspace_version = workspace_version + 1, workspace = null where id = auth.uid()::text;
    raise exception 'Cut plan was deleted';
  exception when check_violation then null; end;
end $$;
rollback;
