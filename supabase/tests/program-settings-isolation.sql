begin;
do $$ begin
  if not exists (select 1 from public.user_program_settings p join auth.users u on u.id = p.owner_id where u.email = 'dan@dpmerron.co.uk' and p.spindle_start_gcode = 'S18000 M03') then raise exception 'Dan programs not provisioned'; end if;
  if exists (select 1 from public.user_program_settings p join auth.users u on u.id = p.owner_id where u.email = 'unconfigured@example.com') then raise exception 'Other account inherited Dan programs'; end if;
end $$;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000011', 'profile-a@example.com'),
  ('00000000-0000-4000-8000-000000000012', 'profile-b@example.com');
grant select, insert, update, delete on public.user_program_settings to authenticated, anon;
create policy "test legacy shared programs" on public.user_program_settings for all using (true) with check (true);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000011';
set local request.jwt.claim.aal = 'aal2';
insert into public.user_program_settings (owner_id, start_gcode, spindle_start_gcode, end_gcode) values (auth.uid(), 'G21', 'S18000 M03', 'M05 M30');
do $$ begin
  if (select count(*) from public.user_program_settings) <> 1 then raise exception 'Own settings missing'; end if;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000012';
do $$ declare affected integer; begin
  if (select count(*) from public.user_program_settings) <> 0 then raise exception 'Foreign settings leaked'; end if;
  update public.user_program_settings set start_gcode = 'M30';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Foreign settings changed'; end if;
  begin
    insert into public.user_program_settings (owner_id, start_gcode, spindle_start_gcode, end_gcode) values ('00000000-0000-4000-8000-000000000011', 'G21', 'S18000 M03', 'M05 M30');
    raise exception 'Owner spoof succeeded';
  exception when insufficient_privilege then null; end;
end $$;
insert into public.user_program_settings (owner_id, start_gcode, spindle_start_gcode, end_gcode) values (auth.uid(), 'G21', 'S16000 M03', 'M05 M30');
set local request.jwt.claim.aal = 'aal1';
do $$ declare affected integer; begin
  if (select count(*) from public.user_program_settings) <> 0 then raise exception 'MFA bypass on read'; end if;
  update public.user_program_settings set start_gcode = 'M30';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'MFA bypass on write'; end if;
end $$;
set local role anon;
set local request.jwt.claim.sub = '';
do $$ begin
  if (select count(*) from public.user_program_settings) <> 0 then raise exception 'Anonymous settings read'; end if;
end $$;
rollback;
