begin;
insert into auth.users(id, email) values
  ('00000000-0000-4000-8000-000000000081', 'machine-a@example.com'),
  ('00000000-0000-4000-8000-000000000082', 'machine-b@example.com');
-- Restrictive policy and immutability must survive accidental broad legacy grants.
grant select, insert, update on public.cnc_machine_runs to authenticated, anon;
create policy "test broad machine policy" on public.cnc_machine_runs for all using (true) with check (true);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000081';
set local request.jwt.claim.aal = 'aal2';
insert into public.cnc_machine_runs(id, owner_id, name, order_number, material, thickness, sheet_count, part_count, snapshot)
values ('00000000-0000-4000-8000-000000000083', auth.uid(), 'Export', '1007', 'Ply', '12', 1, 1, '{"version":1,"files":[]}');
do $$ begin
  if (select count(*) from public.cnc_machine_runs) <> 1 then raise exception 'Own export missing'; end if;
  begin
    update public.cnc_machine_runs set snapshot = '{"version":1,"files":["changed"]}';
    raise exception 'Immutable snapshot changed';
  exception when insufficient_privilege then null; end;
  begin
    update public.cnc_machine_runs set status = 'completed';
    raise exception 'Invalid transition succeeded';
  exception when check_violation then null; end;
end $$;
update public.cnc_machine_runs set status = 'cutting' where status = 'waiting';
do $$ declare affected integer; begin
  update public.cnc_machine_runs set status = 'cancelled' where status = 'waiting';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Stale status update succeeded'; end if;
end $$;
update public.cnc_machine_runs set status = 'completed' where status = 'cutting';
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000082';
do $$ declare affected integer; begin
  if (select count(*) from public.cnc_machine_runs) <> 0 then raise exception 'Foreign export leaked'; end if;
  update public.cnc_machine_runs set status = 'cancelled';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Foreign export changed'; end if;
  begin
    insert into public.cnc_machine_runs(id, owner_id, name, order_number, material, thickness, sheet_count, part_count, snapshot)
    values (gen_random_uuid(), '00000000-0000-4000-8000-000000000081', 'Spoof', '', '', '', 1, 1, '{"version":1,"files":[]}');
    raise exception 'Owner spoof succeeded';
  exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000081';
set local request.jwt.claim.aal = 'aal1';
do $$ begin
  if (select count(*) from public.cnc_machine_runs) <> 0 then raise exception 'MFA bypass'; end if;
end $$;
set local role anon;
set local request.jwt.claim.sub = '';
do $$ begin
  if (select count(*) from public.cnc_machine_runs) <> 0 then raise exception 'Anonymous export leaked'; end if;
end $$;
-- Large exports use one scoped RPC; retries retain the same immutable row.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000081';
set local request.jwt.claim.aal = 'aal2';
do $$
declare
  payload jsonb;
  export_id uuid := '00000000-0000-4000-8000-000000000084';
  result uuid;
begin
  payload := jsonb_build_object('version',1,'material','Ply','thickness','12 mm',
    'map',jsonb_build_object('name','10 sheet regression','order','test','sheetCount',10,'parts',(select jsonb_agg(jsonb_build_object('number',n)) from generate_series(1,86) n)),
    'files',(select jsonb_agg(jsonb_build_object('filename','sheet-'||n||'.nc','gcode',repeat('G01 X100 Y100 F3000' || chr(10),55000))) from generate_series(1,10) n));
  if octet_length(payload::text)<10000000 then raise exception 'Large-export fixture too small'; end if;
  result := public.save_cnc_machine_run(export_id,payload);
  if result<>export_id then raise exception 'Wrong returned export ID'; end if;
  update public.cnc_machine_runs set status='cutting' where id=export_id;
  perform public.save_cnc_machine_run(export_id,payload);
  if (select count(*) from public.cnc_machine_runs where id=export_id)<>1 then raise exception 'Duplicate retry'; end if;
  if not exists(select 1 from public.cnc_machine_runs where id=export_id and snapshot=payload and status='cutting' and part_count=86 and sheet_count=10) then raise exception 'Snapshot or status changed'; end if;
  begin
    perform public.save_cnc_machine_run(export_id,jsonb_set(payload,'{material}','"Different"'));
    raise exception 'Different retry accepted';
  exception when unique_violation then null; end;
  begin
    perform public.save_cnc_machine_run(gen_random_uuid(),'{"version":1,"files":[]}');
    raise exception 'Incomplete snapshot accepted';
  exception when invalid_parameter_value then null; end;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000082';
do $$ begin
  begin
    perform public.save_cnc_machine_run('00000000-0000-4000-8000-000000000084','{"version":1,"files":[],"material":"","thickness":"","map":{"name":"Spoof","order":"","sheetCount":1,"parts":[{}]}}');
    raise exception 'Foreign export ID accepted';
  exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.aal = 'aal1';
do $$ begin
  begin
    perform public.save_cnc_machine_run(gen_random_uuid(),'{}');
    raise exception 'RPC MFA bypass';
  exception when insufficient_privilege then null; end;
end $$;
set local role anon;
do $$ begin
  begin
    perform public.save_cnc_machine_run(gen_random_uuid(),'{}');
    raise exception 'Anonymous RPC access';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
