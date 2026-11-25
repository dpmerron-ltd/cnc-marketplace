begin;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-000000000021','andy-test@example.com');
insert into public.user_program_settings(owner_id,start_gcode,spindle_start_gcode,end_gcode) values ('00000000-0000-4000-8000-000000000021','G21','S16000 M03','M05 M30');
insert into public.cnc_export_machines(machine_key,owner_id) values ('andy','00000000-0000-4000-8000-000000000021'),('dan','00000000-0000-4000-8000-000000000009');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000009';
set local request.jwt.claim.aal = 'aal2';
do $$ begin
 if (select count(*) from public.load_cnc_export_profiles()) <> 2 then raise exception 'Pair missing'; end if;
 if not exists(select 1 from public.load_cnc_export_profiles() where machine_key='dan' and is_current) then raise exception 'Wrong current profile'; end if;
 if (select count(*) from public.user_program_settings) <> 1 then raise exception 'Private settings leaked'; end if;
 begin
  insert into public.cnc_export_machines values ('andy', auth.uid());
  raise exception 'Configuration write allowed';
 exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000010';
do $$ begin
 if exists(select 1 from public.load_cnc_export_profiles()) then raise exception 'Pair leaked to outsider'; end if;
end $$;
set local request.jwt.claim.aal = 'aal1';
do $$ begin
 begin
  perform public.load_cnc_export_profiles();
  raise exception 'MFA bypass';
 exception when raise_exception then if SQLERRM <> 'Verified sign-in required' then raise; end if; end;
end $$;
reset role;
delete from public.user_program_settings where owner_id='00000000-0000-4000-8000-000000000021';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000009';
set local request.jwt.claim.aal = 'aal2';
do $$ begin
 begin
  perform public.load_cnc_export_profiles();
  raise exception 'Incomplete pair accepted';
 exception when raise_exception then if SQLERRM not like 'Both Andy and Dan%' then raise; end if; end;
end $$;
rollback;
