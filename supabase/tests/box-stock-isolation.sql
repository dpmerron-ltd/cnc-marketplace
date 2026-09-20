begin;
insert into auth.users (id) values ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
insert into public.box_stock (id, updated_by, name, length_mm, width_mm, height_mm, quantity)
values ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Shared box', 900, 350, 400, 10);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000002';
set local request.jwt.claim.aal = 'aal2';
do $$ begin
  if (select quantity from public.box_stock where id = '20000000-0000-4000-8000-000000000001') <> 10 then raise exception 'Account B cannot read shared stock'; end if;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$ begin
  if (select quantity from public.box_stock where id = '20000000-0000-4000-8000-000000000001') <> 10 then raise exception 'Account A cannot read shared stock'; end if;
  if (select count(*) from public.box_stock) <> 3 then raise exception 'Seed sizes duplicated or missing'; end if;
  begin
    update public.box_stock set quantity = 999;
    raise exception 'Direct stock overwrite allowed';
  exception when insufficient_privilege then null; end;
  if has_function_privilege('authenticated', 'public.count_cnc_boxes(uuid,uuid,integer,integer)', 'execute') then raise exception 'Authenticated revision bypass'; end if;
  if has_function_privilege('anon', 'public.count_cnc_boxes(uuid,uuid,integer,integer)', 'execute') then raise exception 'Anonymous bypass'; end if;
end $$;
set local request.jwt.claim.aal = 'aal1';
do $$ begin if (select count(*) from public.box_stock) <> 0 then raise exception 'Non-MFA read allowed'; end if; end $$;
set local request.jwt.claim.sub = '';
set local request.jwt.claim.aal = 'aal2';
do $$ begin if (select count(*) from public.box_stock) <> 0 then raise exception 'No-user read allowed'; end if; end $$;
reset role;
set local role service_role;
do $$
declare result jsonb;
begin
  result := public.count_cnc_boxes('00000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 9, 1);
  if result->>'quantity' <> '9' or result->>'version' <> '2' or result ? 'updated_by' then raise exception 'Shared count update failed'; end if;
  if (select updated_by from public.box_stock where id = '20000000-0000-4000-8000-000000000001') <> '00000000-0000-4000-8000-000000000002' then raise exception 'Acting account not recorded'; end if;
  begin
    perform public.count_cnc_boxes('00000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 8, 1);
    raise exception 'Stale update allowed';
  exception when raise_exception then if sqlerrm <> 'BOX_REVISION_CONFLICT' then raise; end if; end;
  begin
    perform public.count_cnc_boxes('00000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', -1, 2);
    raise exception 'Negative stock allowed';
  exception when check_violation then null; end;
  if (select quantity from public.box_stock where id = '20000000-0000-4000-8000-000000000001') <> 9 then raise exception 'Stock corrupted'; end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$ begin
  if (select quantity from public.box_stock where id = '20000000-0000-4000-8000-000000000001') <> 9 then raise exception 'Other account cannot see revised shared count'; end if;
end $$;
rollback;
