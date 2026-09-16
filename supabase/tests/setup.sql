-- Only for an empty, disposable test database, not the Supabase project.
create schema auth;
create role authenticated nologin;
create role anon nologin;
create role service_role nologin bypassrls;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
create function auth.jwt() returns jsonb language sql stable as $$
  select jsonb_build_object('sub', auth.uid(), 'aal', coalesce(nullif(current_setting('request.jwt.claim.aal', true), ''), 'aal1'))
$$;
