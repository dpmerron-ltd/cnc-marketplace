begin;
insert into auth.users(id, email) values ('00000000-0000-4000-8000-000000000081', 'jobs-a@example.com'), ('00000000-0000-4000-8000-000000000082', 'jobs-b@example.com');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000081';
set local request.jwt.claim.aal = 'aal2';
do $$ declare a text; b text; begin
  a := public.reserve_cnc_job_name('00000000-0000-4000-8000-000000000083', auth.uid());
  b := public.reserve_cnc_job_name('00000000-0000-4000-8000-000000000084', auth.uid());
  if a !~ '^\d{4}-\d{2}-\d{2}-001$' or b !~ '-002$' then raise exception 'Daily sequence failed'; end if;
  if public.reserve_cnc_job_name('00000000-0000-4000-8000-000000000083', auth.uid()) <> a then raise exception 'Retry renamed job'; end if;
  begin
    perform public.reserve_cnc_job_name('00000000-0000-4000-8000-000000000085', '00000000-0000-4000-8000-000000000082');
    raise exception 'Owner spoof accepted';
  exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000082';
do $$ begin
  if public.reserve_cnc_job_name('00000000-0000-4000-8000-000000000085', auth.uid()) !~ '-003$' then raise exception 'Sequence is not shared'; end if;
  begin
    perform public.reserve_cnc_job_name('00000000-0000-4000-8000-000000000083', auth.uid());
    raise exception 'Foreign reservation disclosed';
  exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.aal = 'aal1';
do $$ begin
  begin
    perform public.reserve_cnc_job_name('00000000-0000-4000-8000-000000000086', auth.uid());
    raise exception 'MFA bypass';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
