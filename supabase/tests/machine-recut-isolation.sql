begin;
insert into auth.users(id, email) values
  ('00000000-0000-4000-8000-000000000091', 'recut-a@example.com'),
  ('00000000-0000-4000-8000-000000000092', 'recut-b@example.com');
-- Guards must hold even if an old policy or grant is too broad.
grant select, insert, update on public.cnc_machine_recuts to authenticated, anon;
create policy "test broad recut policy" on public.cnc_machine_recuts for all using (true) with check (true);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000091';
set local request.jwt.claim.aal = 'aal2';
insert into public.cnc_machine_runs(id, owner_id, name, order_number, material, thickness, sheet_count, part_count, snapshot)
values ('00000000-0000-4000-8000-000000000093', auth.uid(), 'Rack', '1007', 'Ply', '12 mm', 2, 2,
  '{"version":1,"files":[],"map":{"parts":[{"number":"P001","name":"Side","sheetIndex":0},{"number":"P002","name":"Shelf","sheetIndex":1}]}}');
insert into public.cnc_machine_recuts(owner_id, source_run_id, sheet_index, part_number, part_name, material)
values (auth.uid(), '00000000-0000-4000-8000-000000000093', 0, 'P001', 'Forged name', 'Forged stock');
do $$ begin
  if not exists (select 1 from public.cnc_machine_recuts where part_name = 'Side' and material = 'Ply' and thickness = '12 mm' and job_name = 'Rack' and order_number = '1007' and status = 'queued') then
    raise exception 'Original export details not preserved';
  end if;
  begin
    insert into public.cnc_machine_recuts(owner_id, source_run_id, sheet_index, part_number)
    values (auth.uid(), '00000000-0000-4000-8000-000000000093', 0, 'P001');
    raise exception 'Duplicate pending re-cut allowed';
  exception when unique_violation then null; end;
  begin
    insert into public.cnc_machine_recuts(owner_id, source_run_id, sheet_index, part_number)
    values (auth.uid(), '00000000-0000-4000-8000-000000000093', 0, 'P002');
    raise exception 'Part on wrong sheet accepted';
  exception when check_violation then null; end;
  begin
    insert into public.cnc_machine_recuts(owner_id, source_run_id, sheet_index, part_number)
    values (auth.uid(), '00000000-0000-4000-8000-000000000093', 0, 'P999');
    raise exception 'Unknown part accepted';
  exception when check_violation then null; end;
  begin
    update public.cnc_machine_recuts set part_name = 'Changed';
    raise exception 'Immutable re-cut details changed';
  exception when insufficient_privilege then null; end;
end $$;
update public.cnc_machine_recuts set status = 'completed' where status = 'queued';
do $$ declare affected integer; begin
  update public.cnc_machine_recuts set status = 'cancelled' where status = 'queued';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Stale re-cut update succeeded'; end if;
  begin
    update public.cnc_machine_recuts set status = 'queued';
    raise exception 'Completed re-cut reopened';
  exception when check_violation then null; end;
end $$;
-- A later replacement for the same part is a new request with separate history.
insert into public.cnc_machine_recuts(owner_id, source_run_id, sheet_index, part_number)
values (auth.uid(), '00000000-0000-4000-8000-000000000093', 0, 'P001'),
       (auth.uid(), '00000000-0000-4000-8000-000000000093', 1, 'P002');
update public.cnc_machine_recuts set status = 'cancelled' where part_number = 'P002';
do $$ begin
  if (select count(*) from public.cnc_machine_recuts) <> 3 then raise exception 'Re-cut history missing'; end if;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000092';
do $$ declare affected integer; begin
  if (select count(*) from public.cnc_machine_recuts) <> 0 then raise exception 'Foreign re-cuts leaked'; end if;
  update public.cnc_machine_recuts set status = 'cancelled' where status = 'queued';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Foreign re-cut changed'; end if;
  begin
    insert into public.cnc_machine_recuts(owner_id, source_run_id, sheet_index, part_number)
    values (auth.uid(), '00000000-0000-4000-8000-000000000093', 0, 'P001');
    raise exception 'Foreign export queued';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.cnc_machine_recuts(owner_id, source_run_id, sheet_index, part_number)
    values ('00000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-000000000093', 0, 'P001');
    raise exception 'Re-cut owner spoofed';
  exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000091';
set local request.jwt.claim.aal = 'aal1';
do $$ begin
  if (select count(*) from public.cnc_machine_recuts) <> 0 then raise exception 'Re-cut MFA bypass'; end if;
  begin
    insert into public.cnc_machine_recuts(owner_id, source_run_id, sheet_index, part_number)
    values (auth.uid(), '00000000-0000-4000-8000-000000000093', 0, 'P001');
    raise exception 'Re-cut write without MFA';
  exception when insufficient_privilege then null; end;
end $$;
set local role anon;
set local request.jwt.claim.sub = '';
do $$ begin
  if (select count(*) from public.cnc_machine_recuts) <> 0 then raise exception 'Anonymous re-cut access'; end if;
end $$;
rollback;
