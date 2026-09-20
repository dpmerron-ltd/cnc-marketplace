begin;
grant usage on schema public to authenticated, anon, service_role;
insert into auth.users(id) values ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$
begin
  begin
    perform public.create_cnc_api_key('No MFA');
    raise exception 'MFA bypass allowed';
  exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.aal = 'aal2';
do $$
declare result jsonb;
begin
  result := public.create_cnc_api_key('Automation');
  if result->>'token' !~ '^cnc_[0-9a-f]{64}$' then raise exception 'Weak or malformed API token'; end if;
  if (select count(*) from public.cnc_api_keys) <> 1 then raise exception 'Own key not visible'; end if;
  begin
    perform token_hash from public.cnc_api_keys;
    raise exception 'Key hash readable by user';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.cnc_jobs(id, owner_id, idempotency_key, request_hash, job_name, order_number, part_count, sheet_count, manifest, files, status_history)
      values(gen_random_uuid(), auth.uid(), 'bypass', 'hash', 'A', 'O', 1, 1, '{}', '[]', '[]');
    raise exception 'User can bypass job generation';
  exception when insufficient_privilege then null; end;
  begin
    perform public.publish_cnc_job(auth.uid(), gen_random_uuid(), 'bypass', 'hash', '{}', '[]', '[]', 'spoof');
    raise exception 'User can invoke privileged publish';
  exception when insufficient_privilege then null; end;
end $$;

set local role service_role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-000000000001';
  id uuid := '10000000-0000-4000-8000-000000000001';
  m jsonb := '{"request":{"jobName":"Test","orderNumber":"ORDER"},"cuts":[{}],"sheets":[{}]}';
  files jsonb := '[{"name":"sheet-plan.pdf"},{"name":"labels.pdf"},{"name":"manifest.json"},{"name":"sheet-1.nc"}]';
  artifacts jsonb := '[{"name":"sheet-plan.pdf","contentType":"application/pdf","dataBase64":"YQ=="},{"name":"labels.pdf","contentType":"application/pdf","dataBase64":"YQ=="},{"name":"manifest.json","contentType":"application/json","dataBase64":"e30="},{"name":"sheet-1.nc","contentType":"text/plain","dataBase64":"YQ=="}]';
  first public.cnc_jobs; replay public.cnc_jobs; i integer;
begin
  first := public.publish_cnc_job(a, id, 'order-1', 'hash1', m, files, artifacts, 'api_key:test');
  replay := public.publish_cnc_job(a, gen_random_uuid(), 'order-1', 'hash1', m, files, artifacts, 'api_key:test');
  if first.id <> replay.id or first.status <> 'awaiting_review' then raise exception 'Idempotency/review state failed'; end if;
  if (select count(*) from public.cnc_job_artifacts where job_id = id) <> 4 then raise exception 'Incomplete artifacts'; end if;
  begin
    perform public.publish_cnc_job(a, gen_random_uuid(), 'order-1', 'hash2', m, files, artifacts, 'api_key:test');
    raise exception 'Conflict not rejected';
  exception when raise_exception then if sqlerrm <> 'IDEMPOTENCY_CONFLICT' then raise; end if; end;
  begin
    perform public.publish_cnc_job(a, gen_random_uuid(), 'broken', 'hash3', m, files, '[]', 'api_key:test');
    raise exception 'Incomplete artifacts published';
  exception when raise_exception then if sqlerrm <> 'Incomplete job artifacts' then raise; end if; end;
  if exists(select 1 from public.cnc_jobs where idempotency_key = 'broken') then raise exception 'Partial job survived rollback'; end if;
  perform public.transition_cnc_job(a, id, 'awaiting_review', 'ready', 'user:a');
  begin
    perform public.transition_cnc_job(a, id, 'awaiting_review', 'ready', 'user:a');
    raise exception 'Stale transition accepted';
  exception when raise_exception then if sqlerrm <> 'STATUS_CONFLICT' then raise; end if; end;
  if (select jsonb_array_length(status_history) from public.cnc_jobs where cnc_jobs.id = first.id) <> 2 then raise exception 'Audit history missing'; end if;
  for i in 1..60 loop if not public.allow_cnc_api_request(a) then raise exception 'Rate limited too early'; end if; end loop;
  if public.allow_cnc_api_request(a) then raise exception 'Rate limit missing'; end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
do $$
begin
  if (select count(*) from public.cnc_jobs) <> 0 or (select count(*) from public.cnc_job_artifacts) <> 0 or (select count(*) from public.cnc_api_keys) <> 0 then raise exception 'Cross-account read'; end if;
  begin
    update public.cnc_jobs set status = 'ready';
    raise exception 'Direct status writes allowed';
  exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$
declare key_id uuid;
begin
  if (select count(*) from public.cnc_jobs) <> 1 or (select count(*) from public.cnc_job_artifacts) <> 4 then raise exception 'Own job unavailable'; end if;
  select id into key_id from public.cnc_api_keys;
  perform public.revoke_cnc_api_key(key_id);
  if not exists(select 1 from public.cnc_api_keys where id = key_id and revoked_at is not null) then raise exception 'Revocation failed'; end if;
end $$;
set local role anon;
do $$
begin
  begin perform id from public.cnc_jobs; raise exception 'Anonymous job read allowed'; exception when insufficient_privilege then null; end;
  begin perform public.create_cnc_api_key('anon'); raise exception 'Anonymous key creation allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
insert into public.marketplace_items(id, owner_id, name) values ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'CAS item');
insert into public.cnc_components(id, owner_id, item_id, name, sku, original_filename, gcode, dxf, width, height, bounding_box, original_bounds, metadata)
  values ('cas-part', '00000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Original name', 'Original SKU', 'original.nc', 'G21', 'original DXF', 1, 1, '{}', '{}', '{}');
do $$
declare a uuid := '00000000-0000-4000-8000-000000000001'; b uuid := '00000000-0000-4000-8000-000000000002'; item uuid := '30000000-0000-4000-8000-000000000001'; sha text := encode(extensions.digest('G21', 'sha256'), 'hex');
begin
  begin
    perform public.replace_cnc_component_gcode(b, item, 'cas-part', sha, null, 'original DXF', 'G21 new', '{}', 2, 3, '{}', '{}', '{}');
    raise exception 'Foreign replacement allowed';
  exception when others then if sqlerrm <> 'COMPONENT_NOT_FOUND' then raise; end if; end;
  begin
    perform public.replace_cnc_component_gcode(a, item, 'cas-part', 'wrong', null, 'original DXF', 'G21 new', '{}', 2, 3, '{}', '{}', '{}');
    raise exception 'Stale NC replacement allowed';
  exception when others then if sqlerrm <> 'COMPONENT_REVISION_CONFLICT' then raise; end if; end;
  begin
    perform public.replace_cnc_component_gcode(a, item, 'cas-part', sha, '{"changed":true}', 'original DXF', 'G21 new', '{}', 2, 3, '{}', '{}', '{}');
    raise exception 'Stale variants replacement allowed';
  exception when others then if sqlerrm <> 'COMPONENT_REVISION_CONFLICT' then raise; end if; end;
  begin
    perform public.replace_cnc_component_gcode(a, item, 'cas-part', sha, null, 'stale DXF', 'G21 new', '{}', 2, 3, '{}', '{}', '{}');
    raise exception 'Stale source replacement allowed';
  exception when others then if sqlerrm <> 'COMPONENT_REVISION_CONFLICT' then raise; end if; end;
  if not public.replace_cnc_component_gcode(a, item, 'cas-part', sha, null, 'original DXF', 'G21 new', '{}', 2, 3, '{}', '{}', '{}') then raise exception 'Replacement failed'; end if;
  if public.replace_cnc_component_gcode(a, item, 'cas-part', sha, null, 'original DXF', 'G21 new', '{}', 2, 3, '{}', '{}', '{}') then raise exception 'Replay was not idempotent'; end if;
  if not exists(select 1 from public.cnc_components where id = 'cas-part' and item_id = item and owner_id = a and name = 'Original name' and sku = 'Original SKU' and original_filename = 'original.nc' and dxf = 'original DXF' and gcode = 'G21 new' and width = 2 and height = 3) then raise exception 'Identity/source not preserved'; end if;
  if has_function_privilege('authenticated', 'public.replace_cnc_component_gcode(uuid,uuid,text,text,jsonb,text,text,jsonb,double precision,double precision,jsonb,jsonb,jsonb)', 'execute') or has_function_privilege('anon', 'public.replace_cnc_component_gcode(uuid,uuid,text,text,jsonb,text,text,jsonb,double precision,double precision,jsonb,jsonb,jsonb)', 'execute') then raise exception 'Replacement RPC exposed'; end if;
end $$;
rollback;
