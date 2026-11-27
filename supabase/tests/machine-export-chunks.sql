begin;
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000009';
set local request.jwt.claim.aal='aal2';
do $$
declare payload text; hash text; eid uuid := gen_random_uuid(); chunks integer; idx integer; content text;
begin
 payload := jsonb_build_object('version',1,'material','Ply','thickness','12','map',jsonb_build_object('name','57 MB regression','order','test','sheetCount',10,'parts','[{}]'::jsonb),'files',jsonb_build_array(jsonb_build_object('gcode',repeat('G01 X100 Y100 F3000' || chr(10),3000000))))::text;
 if octet_length(payload)<57000000 then raise exception 'Fixture too small'; end if;
 hash := encode(sha256(convert_to(payload,'UTF8')),'hex');
 chunks := ceil(length(payload)::numeric/1048576)::integer;
 for idx in 0..chunks-1 loop
  content := substring(payload from idx*1048576+1 for 1048576);
  perform public.upload_cnc_machine_run_chunk(eid,idx,chunks,hash,content);
  if idx=0 then
   perform public.upload_cnc_machine_run_chunk(eid,idx,chunks,hash,content);
   begin
    perform public.finish_cnc_machine_run_upload(eid,chunks,hash);
    raise exception 'Incomplete accepted';
   exception when invalid_parameter_value then null; end;
   begin
    perform public.upload_cnc_machine_run_chunk(eid,idx,chunks,hash,'changed');
    raise exception 'Changed chunk accepted';
   exception when unique_violation then null; end;
  end if;
 end loop;
 perform public.finish_cnc_machine_run_upload(eid,chunks,hash);
 if not exists(select 1 from public.cnc_machine_runs where id=eid and snapshot->>'storage'='chunks-v1' and snapshot->>'sha256'=hash) then raise exception 'Snapshot mismatch'; end if;
 if (select string_agg(c.content,'' order by c.chunk_index) from public.cnc_machine_run_chunks c where c.export_id=eid) <> payload then raise exception 'Saved chunks differ'; end if;
 begin
  delete from public.cnc_machine_run_chunks where export_id=eid;
  raise exception 'Saved chunks deleted';
 exception when insufficient_privilege then null; end;
 -- Retrying after a lost success response must retain the same row and status.
 update public.cnc_machine_runs set status='cutting' where id=eid;
 for idx in 0..chunks-1 loop
  perform public.upload_cnc_machine_run_chunk(eid,idx,chunks,hash,substring(payload from idx*1048576+1 for 1048576));
 end loop;
 perform public.finish_cnc_machine_run_upload(eid,chunks,hash);
 if not exists(select 1 from public.cnc_machine_runs where id=eid and status='cutting') then raise exception 'Retry changed status'; end if;
end $$;
-- Account and MFA protection also applies to incomplete uploads.
select public.upload_cnc_machine_run_chunk('00000000-0000-4000-8000-000000000099',0,1,repeat('a',64),'bad checksum');
do $$ begin
 begin
  perform public.finish_cnc_machine_run_upload('00000000-0000-4000-8000-000000000099',1,repeat('a',64));
  raise exception 'Bad checksum accepted';
 exception when invalid_parameter_value then null; end;
end $$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000010';
do $$ begin
 if exists(select 1 from public.cnc_machine_run_chunks) then raise exception 'Foreign chunks leaked'; end if;
 begin
  perform public.finish_cnc_machine_run_upload('00000000-0000-4000-8000-000000000099',1,repeat('a',64));
  raise exception 'Foreign chunks finalized';
 exception when invalid_parameter_value then null; end;
 begin
  perform public.upload_cnc_machine_run_chunk('00000000-0000-4000-8000-000000000099',0,1,repeat('a',64),'bad checksum');
  raise exception 'Foreign chunk overwritten';
 exception when unique_violation then null; end;
end $$;
set local request.jwt.claim.aal='aal1';
do $$ begin
 begin
  perform public.upload_cnc_machine_run_chunk(gen_random_uuid(),0,1,repeat('a',64),'x');
  raise exception 'MFA bypass';
 exception when insufficient_privilege then null; end;
end $$;
set local role anon;
do $$ begin
 begin
  perform public.finish_cnc_machine_run_upload(gen_random_uuid(),1,repeat('a',64));
  raise exception 'Anonymous finalize';
 exception when insufficient_privilege then null; end;
end $$;
rollback;
