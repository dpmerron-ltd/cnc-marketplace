begin;
insert into auth.users(id, email) values
  ('00000000-0000-4000-8000-000000000021', 'cutter1@example.com'),
  ('00000000-0000-4000-8000-000000000022', 'cutter2@example.com');
set local role authenticated;
do $$ begin
  begin perform * from public.cnc_order_admin; raise exception 'browser read admin table'; exception when insufficient_privilege then null; end;
  begin perform * from public.cnc_order_assignments; raise exception 'browser read assignment table'; exception when insufficient_privilege then null; end;
  begin perform * from public.cnc_order_assignment_history; raise exception 'browser read history'; exception when insufficient_privilege then null; end;
  begin perform public.cnc_order_users('00000000-0000-4000-8000-000000000009', 0); raise exception 'browser enumerated users'; exception when insufficient_privilege then null; end;
  begin perform public.assign_cnc_order('00000000-0000-4000-8000-000000000009', 'test.myshopify.com', '123', '#1007', null, null, 0); raise exception 'browser forged admin'; exception when insufficient_privilege then null; end;
  begin update public.cnc_order_admin set user_id = '00000000-0000-4000-8000-000000000021'; raise exception 'browser promoted itself'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
do $$
declare a uuid := '00000000-0000-4000-8000-000000000009';
  b uuid := '00000000-0000-4000-8000-000000000021';
  c uuid := '00000000-0000-4000-8000-000000000022';
  rows jsonb;
begin
  begin perform public.cnc_order_users(b, 0); raise exception 'worker enumerated users'; exception when others then if sqlerrm <> 'ORDER_FORBIDDEN' then raise; end if; end;
  begin perform public.assign_cnc_order(b, 'test.myshopify.com', '123', '#1007', b, 4500, 0); raise exception 'worker assigned order'; exception when others then if sqlerrm <> 'ORDER_FORBIDDEN' then raise; end if; end;
  if (select count(*) from public.cnc_order_users(a, 0)) < 3 then raise exception 'admin missing users'; end if;
  perform public.assign_cnc_order(a, 'test.myshopify.com', '123', '#1007', b, 4500, 0);
  rows := public.read_cnc_order_assignments(b, 'test.myshopify.com');
  if jsonb_array_length(rows) <> 1 or rows->0->>'payment_pence' <> '4500' or rows->0->>'assignee_email' is not null then raise exception 'worker assignment invalid'; end if;
  if public.read_cnc_order_assignments(c, 'test.myshopify.com') <> '[]'::jsonb then raise exception 'cross-user leak'; end if;
  if public.read_cnc_order_assignments(b, 'different.myshopify.com') <> '[]'::jsonb then raise exception 'cross-store leak'; end if;
  if public.read_cnc_order_assignments(b, 'test.myshopify.com', array['999']) <> '[]'::jsonb then raise exception 'ID filter leak'; end if;
  if public.read_cnc_order_assignments(b, 'test.myshopify.com', null, 0, 'missing') <> '[]'::jsonb then raise exception 'search ignored'; end if;
  begin perform public.assign_cnc_order(a, 'test.myshopify.com', '123', '#1007', c, 100, 0); raise exception 'stale update accepted'; exception when others then if sqlerrm <> 'ORDER_REVISION_CONFLICT' then raise; end if; end;
  begin perform public.assign_cnc_order(a, 'test.myshopify.com', '123', '#1007', c, -1, 1); raise exception 'negative payment accepted'; exception when others then if sqlerrm <> 'ORDER_INVALID' then raise; end if; end;
  begin perform public.assign_cnc_order(a, 'test.myshopify.com', '123', '#1007', '00000000-0000-4000-8000-000000000099', 100, 1); raise exception 'missing user accepted'; exception when others then if sqlerrm <> 'ORDER_USER_NOT_FOUND' then raise; end if; end;
  perform public.assign_cnc_order(a, 'test.myshopify.com', '123', '#1007', c, 5000, 1);
  if public.read_cnc_order_assignments(b, 'test.myshopify.com') <> '[]'::jsonb then raise exception 'reassignment did not revoke access'; end if;
  rows := public.read_cnc_order_assignments(a, 'test.myshopify.com');
  if rows->0->>'assignee_email' <> 'cutter2@example.com' or rows->0->>'version' <> '2' then raise exception 'admin assignment invalid'; end if;
  perform public.assign_cnc_order(a, 'test.myshopify.com', '123', '#1007', null, null, 2);
  if public.read_cnc_order_assignments(c, 'test.myshopify.com') <> '[]'::jsonb then raise exception 'unassignment did not revoke access'; end if;
  begin perform public.assign_cnc_order(a, 'test.myshopify.com', '123', '#1007', b, 100, 0); raise exception 'version reset accepted'; exception when others then if sqlerrm <> 'ORDER_REVISION_CONFLICT' then raise; end if; end;
end $$;
reset role;
do $$ begin
  if (select count(*) from public.cnc_order_assignment_history where order_id = '123') <> 3 then raise exception 'history missing'; end if;
end $$;
set local role anon;
do $$ begin
  begin perform * from public.cnc_order_assignments; raise exception 'anonymous read'; exception when insufficient_privilege then null; end;
  begin perform public.read_cnc_order_assignments('00000000-0000-4000-8000-000000000009', 'test.myshopify.com'); raise exception 'anonymous forged reader'; exception when insufficient_privilege then null; end;
end $$;
rollback;
