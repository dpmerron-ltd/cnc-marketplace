begin;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.cnc_api_keys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  token_prefix text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days',
  revoked_at timestamptz
);
create table if not exists public.cnc_jobs (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (length(idempotency_key) between 1 and 128),
  request_hash text not null,
  job_name text not null,
  order_number text not null,
  status text not null default 'awaiting_review' check (status in ('awaiting_review', 'ready', 'cutting', 'completed', 'cancelled')),
  part_count integer not null check (part_count between 1 and 20),
  sheet_count integer not null check (sheet_count between 1 and 20),
  manifest jsonb not null,
  files jsonb not null,
  status_history jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, idempotency_key),
  unique(id, owner_id)
);
create index if not exists cnc_jobs_queue on public.cnc_jobs(owner_id, created_at desc);
create table if not exists public.cnc_job_artifacts (
  job_id uuid not null,
  owner_id uuid not null,
  name text not null,
  content_type text not null,
  data_base64 text not null check (length(data_base64) <= 16000000),
  primary key(job_id, name),
  foreign key(job_id, owner_id) references public.cnc_jobs(id, owner_id) on delete cascade
);
create table if not exists public.cnc_api_rate_limits (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  requests integer not null
);

alter table public.cnc_api_keys enable row level security;
alter table public.cnc_jobs enable row level security;
alter table public.cnc_job_artifacts enable row level security;
alter table public.cnc_api_rate_limits enable row level security;
revoke all on public.cnc_api_keys, public.cnc_jobs, public.cnc_job_artifacts, public.cnc_api_rate_limits from anon, authenticated;
grant select(id, owner_id, name, token_prefix, created_at, expires_at, revoked_at) on public.cnc_api_keys to authenticated;
grant select on public.cnc_jobs, public.cnc_job_artifacts to authenticated;
grant all on public.cnc_api_keys, public.cnc_jobs, public.cnc_job_artifacts, public.cnc_api_rate_limits to service_role;
drop policy if exists "own api keys" on public.cnc_api_keys;
create policy "own api keys" on public.cnc_api_keys for select to authenticated using (owner_id = auth.uid());
drop policy if exists "own jobs" on public.cnc_jobs;
create policy "own jobs" on public.cnc_jobs for select to authenticated using (owner_id = auth.uid());
drop policy if exists "own job files" on public.cnc_job_artifacts;
create policy "own job files" on public.cnc_job_artifacts for select to authenticated using (owner_id = auth.uid());

create or replace function public.create_cnc_api_key(p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare secret text; key_id uuid; prefix text;
begin
  if auth.uid() is null or coalesce(auth.jwt()->>'aal', '') <> 'aal2' then raise insufficient_privilege using message = 'An MFA-verified session is required.'; end if;
  if length(trim(p_name)) not between 1 and 80 then raise exception 'Key name must be 1-80 characters.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 1));
  if (select count(*) from public.cnc_api_keys where owner_id = auth.uid() and revoked_at is null and expires_at > now()) >= 10 then raise exception 'Revoke an existing key before creating another (limit 10).'; end if;
  secret := 'cnc_' || encode(extensions.gen_random_bytes(32), 'hex');
  prefix := left(secret, 12);
  insert into public.cnc_api_keys(owner_id, name, token_prefix, token_hash)
    values(auth.uid(), trim(p_name), prefix, encode(extensions.digest(secret, 'sha256'), 'hex')) returning id into key_id;
  return jsonb_build_object('id', key_id, 'token', secret, 'prefix', prefix);
end $$;
create or replace function public.revoke_cnc_api_key(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or coalesce(auth.jwt()->>'aal', '') <> 'aal2' then raise insufficient_privilege using message = 'An MFA-verified session is required.'; end if;
  update public.cnc_api_keys set revoked_at = now() where id = p_id and owner_id = auth.uid() and revoked_at is null;
end $$;
revoke all on function public.create_cnc_api_key(text), public.revoke_cnc_api_key(uuid) from public, anon;
grant execute on function public.create_cnc_api_key(text), public.revoke_cnc_api_key(uuid) to authenticated;

-- Only the authenticated backend may publish immutable job snapshots and files.
create or replace function public.publish_cnc_job(p_owner uuid, p_id uuid, p_key text, p_hash text, p_manifest jsonb, p_files jsonb, p_artifacts jsonb, p_actor text)
returns public.cnc_jobs language plpgsql security definer set search_path = '' as $$
declare result public.cnc_jobs; artifact jsonb;
begin
  insert into public.cnc_jobs(id, owner_id, idempotency_key, request_hash, job_name, order_number, part_count, sheet_count, manifest, files, status_history)
  values(p_id, p_owner, p_key, p_hash, p_manifest->'request'->>'jobName', p_manifest->'request'->>'orderNumber', jsonb_array_length(p_manifest->'cuts'), jsonb_array_length(p_manifest->'sheets'), p_manifest, p_files,
    jsonb_build_array(jsonb_build_object('status', 'awaiting_review', 'at', now(), 'actor', p_actor)))
  on conflict(owner_id, idempotency_key) do nothing returning * into result;
  if result.id is null then
    select * into result from public.cnc_jobs where owner_id = p_owner and idempotency_key = p_key;
    if result.request_hash <> p_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return result;
  end if;
  if jsonb_array_length(p_files) <> jsonb_array_length(p_artifacts) or jsonb_array_length(p_files) < 4 then raise exception 'Incomplete job artifacts'; end if;
  for artifact in select value from jsonb_array_elements(p_artifacts) loop
    if not exists(select 1 from jsonb_array_elements(p_files) f where f->>'name' = artifact->>'name') then raise exception 'Unknown job artifact'; end if;
    insert into public.cnc_job_artifacts(job_id, owner_id, name, content_type, data_base64)
      values(p_id, p_owner, artifact->>'name', artifact->>'contentType', artifact->>'dataBase64');
  end loop;
  return result;
end $$;

create or replace function public.transition_cnc_job(p_owner uuid, p_id uuid, p_expected text, p_status text, p_actor text)
returns public.cnc_jobs language plpgsql security definer set search_path = '' as $$
declare result public.cnc_jobs;
begin
  if not ((p_expected = 'awaiting_review' and p_status in ('ready', 'cancelled')) or
          (p_expected = 'ready' and p_status in ('cutting', 'cancelled')) or
          (p_expected = 'cutting' and p_status in ('completed', 'cancelled'))) then raise exception 'INVALID_TRANSITION'; end if;
  update public.cnc_jobs set status = p_status, updated_at = now(),
    status_history = status_history || jsonb_build_array(jsonb_build_object('status', p_status, 'at', now(), 'actor', p_actor))
    where id = p_id and owner_id = p_owner and status = p_expected returning * into result;
  if result.id is null then raise exception 'STATUS_CONFLICT'; end if;
  return result;
end $$;

create or replace function public.allow_cnc_api_request(p_owner uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare used integer;
begin
  insert into public.cnc_api_rate_limits(owner_id, window_start, requests) values(p_owner, date_trunc('minute', now()), 1)
  on conflict(owner_id) do update set window_start = excluded.window_start,
    requests = case when cnc_api_rate_limits.window_start = excluded.window_start then cnc_api_rate_limits.requests + 1 else 1 end
  returning requests into used;
  return used <= 60;
end $$;
revoke all on function public.publish_cnc_job(uuid, uuid, text, text, jsonb, jsonb, jsonb, text), public.transition_cnc_job(uuid, uuid, text, text, text), public.allow_cnc_api_request(uuid) from public, anon, authenticated;
grant execute on function public.publish_cnc_job(uuid, uuid, text, text, jsonb, jsonb, jsonb, text), public.transition_cnc_job(uuid, uuid, text, text, text), public.allow_cnc_api_request(uuid) to service_role;
-- API-only compare-and-swap: preserve identity, source DXF and all unrelated rows.
create or replace function public.replace_cnc_component_gcode(
  p_owner uuid, p_item uuid, p_id text, p_expected_sha text, p_expected_variants jsonb,
  p_expected_dxf text, p_gcode text, p_variants jsonb, p_width double precision,
  p_height double precision, p_bounds jsonb, p_original_bounds jsonb, p_metadata jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare current_part public.cnc_components;
begin
  select * into current_part from public.cnc_components
    where id = p_id and owner_id = p_owner and item_id = p_item for update;
  if current_part.id is null then raise exception 'COMPONENT_NOT_FOUND'; end if;
  if current_part.dxf is distinct from p_expected_dxf then raise exception 'COMPONENT_REVISION_CONFLICT'; end if;
  if current_part.gcode = p_gcode and current_part.material_variants is not distinct from p_variants then return false; end if;
  if encode(extensions.digest(current_part.gcode, 'sha256'), 'hex') is distinct from p_expected_sha
    or current_part.material_variants is distinct from p_expected_variants then raise exception 'COMPONENT_REVISION_CONFLICT'; end if;
  update public.cnc_components set gcode = p_gcode, material_variants = p_variants,
    width = p_width, height = p_height, bounding_box = p_bounds,
    original_bounds = p_original_bounds, metadata = p_metadata
    where id = p_id and owner_id = p_owner and item_id = p_item;
  return true;
end $$;
revoke all on function public.replace_cnc_component_gcode(uuid, uuid, text, text, jsonb, text, text, jsonb, double precision, double precision, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.replace_cnc_component_gcode(uuid, uuid, text, text, jsonb, text, text, jsonb, double precision, double precision, jsonb, jsonb, jsonb) to service_role;
commit;
