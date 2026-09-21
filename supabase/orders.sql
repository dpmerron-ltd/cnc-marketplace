begin;

-- Pin the administrator to an account ID once, never to editable profile metadata.
create table if not exists public.cnc_order_admin (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references auth.users(id)
);
insert into public.cnc_order_admin (user_id)
  select id from auth.users where lower(email) = 'dan@dpmerron.co.uk'
  on conflict (singleton) do nothing;

create table if not exists public.cnc_order_assignments (
  shop text not null check (shop ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  order_id text not null check (order_id ~ '^[0-9]{1,30}$'),
  order_name text not null check (length(order_name) between 1 and 200),
  assignee_id uuid references auth.users(id),
  payment_pence integer,
  currency text not null default 'GBP' check (currency = 'GBP'),
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id),
  primary key (shop, order_id),
  check ((assignee_id is null and payment_pence is null) or
    (assignee_id is not null and payment_pence is not null and payment_pence between 0 and 100000000))
);
create index if not exists cnc_orders_assignee_idx on public.cnc_order_assignments (assignee_id, shop, order_id);
create table if not exists public.cnc_order_assignment_history (
  id bigint generated always as identity primary key,
  shop text not null,
  order_id text not null,
  version integer not null,
  assignee_id uuid,
  payment_pence integer,
  changed_by uuid not null,
  changed_at timestamptz not null default now(),
  unique (shop, order_id, version)
);
alter table public.cnc_order_admin enable row level security;
alter table public.cnc_order_assignments enable row level security;
alter table public.cnc_order_assignment_history enable row level security;
-- All access goes through the authenticated API. No browser writes or role promotion.
revoke all on public.cnc_order_admin, public.cnc_order_assignments, public.cnc_order_assignment_history from public, anon, authenticated;
grant select on public.cnc_order_admin to service_role;

create or replace function public.cnc_order_users(p_actor uuid, p_offset integer default 0)
returns table(id uuid, email text) language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.cnc_order_admin where user_id = p_actor) then raise exception 'ORDER_FORBIDDEN'; end if;
  if p_offset < 0 or p_offset > 100000 then raise exception 'ORDER_INVALID'; end if;
  return query select u.id, u.email::text from auth.users u where u.email is not null order by u.email, u.id limit 101 offset p_offset;
end $$;

create or replace function public.read_cnc_order_assignments(p_actor uuid, p_shop text, p_ids text[] default null, p_offset integer default 0, p_search text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare is_admin boolean;
begin
  if p_offset < 0 or p_offset > 100000 or length(p_search) > 80 or cardinality(p_ids) > 25 then raise exception 'ORDER_INVALID'; end if;
  select exists (select 1 from public.cnc_order_admin where user_id = p_actor) into is_admin;
  return coalesce((select jsonb_agg(to_jsonb(r)) from (
    select a.order_id, a.assignee_id, case when is_admin then u.email else null end as assignee_email,
      a.payment_pence, a.currency, a.version, a.updated_at
    from public.cnc_order_assignments a left join auth.users u on u.id = a.assignee_id
    where a.shop = p_shop and (is_admin or a.assignee_id = p_actor)
      and (p_ids is null or a.order_id = any(p_ids))
      and position(lower(p_search) in lower(a.order_name)) > 0
    order by a.order_id limit 26 offset p_offset
  ) r), '[]'::jsonb);
end $$;

create or replace function public.assign_cnc_order(p_actor uuid, p_shop text, p_order_id text, p_order_name text,
  p_assignee uuid, p_payment_pence integer, p_expected_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare current_assignment public.cnc_order_assignments;
begin
  if not exists (select 1 from public.cnc_order_admin where user_id = p_actor) then raise exception 'ORDER_FORBIDDEN'; end if;
  if p_expected_version is null or p_expected_version < 0 or
    (p_assignee is null and p_payment_pence is not null) or
    (p_assignee is not null and (p_payment_pence is null or p_payment_pence < 0 or p_payment_pence > 100000000)) then raise exception 'ORDER_INVALID'; end if;
  if p_assignee is not null and not exists (select 1 from auth.users where id = p_assignee and email is not null) then raise exception 'ORDER_USER_NOT_FOUND'; end if;
  -- Serialize the first assignment too; a missing row cannot be locked with FOR UPDATE.
  perform pg_advisory_xact_lock(hashtextextended(p_shop || '/' || p_order_id, 0));
  select * into current_assignment from public.cnc_order_assignments where shop = p_shop and order_id = p_order_id for update;
  if coalesce(current_assignment.version, 0) <> p_expected_version then raise exception 'ORDER_REVISION_CONFLICT'; end if;
  insert into public.cnc_order_assignments(shop, order_id, order_name, assignee_id, payment_pence, version, updated_by)
    values(p_shop, p_order_id, p_order_name, p_assignee, p_payment_pence, p_expected_version + 1, p_actor)
    on conflict (shop, order_id) do update set order_name = excluded.order_name, assignee_id = excluded.assignee_id,
      payment_pence = excluded.payment_pence, version = excluded.version, updated_by = excluded.updated_by, updated_at = now();
  insert into public.cnc_order_assignment_history(shop, order_id, version, assignee_id, payment_pence, changed_by)
    values(p_shop, p_order_id, p_expected_version + 1, p_assignee, p_payment_pence, p_actor);
end $$;
revoke all on function public.cnc_order_users(uuid, integer), public.read_cnc_order_assignments(uuid, text, text[], integer, text), public.assign_cnc_order(uuid, text, text, text, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.cnc_order_users(uuid, integer), public.read_cnc_order_assignments(uuid, text, text[], integer, text), public.assign_cnc_order(uuid, text, text, text, uuid, integer, integer) to service_role;
commit;
