begin;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000088','workspace-version@example.com');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000088';
set local request.jwt.claim.aal = 'aal2';
do $$ declare v integer; a jsonb := '{"activeId":"job","jobs":[{"id":"job","sheet":{"instances":[]},"sheets":{}}]}'; b jsonb; begin
  v := public.save_cnc_workspace(auth.uid(), a, '{}', null, 0);
  if v <> 1 then raise exception 'First save version invalid'; end if;
  if public.save_cnc_workspace(auth.uid(), a, '{}', null, 0) <> 1 then raise exception 'Lost response retry failed'; end if;
  b := jsonb_set(a,'{jobs,0,sheet,width}','1220');
  if public.save_cnc_workspace(auth.uid(), b, '{}', null, 1) <> 2 then raise exception 'Second save version invalid'; end if;
  begin
    perform public.save_cnc_workspace(auth.uid(), a, '{}', null, 1);
    raise exception 'Stale device overwrote newer waiting work';
  exception when serialization_failure then null; end;
  begin
    perform public.save_cnc_workspace('00000000-0000-4000-8000-000000000009', a, '{}', null, 2);
    raise exception 'Account switching bypass';
  exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.aal = 'aal1';
do $$ begin
  begin
    perform public.save_cnc_workspace(auth.uid(), '{"jobs":[]}', '{}', null, 2);
    raise exception 'MFA bypass';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
