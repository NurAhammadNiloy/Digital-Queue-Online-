-- Bind authorization and mutation in one transaction; reuse the existing RPCs.
create function public.perform_staff_queue_action(
  p_token_hash text, p_action text, p_service_id uuid default null, p_ticket_id uuid default null
)
returns setof public.queue_tickets
language plpgsql security definer set search_path = ''
as $$
declare
  v_staff_id uuid;
  v_org uuid;
  v_service_id uuid;
begin
  select staff_id into v_staff_id from private.app_sessions
  where token_hash = p_token_hash and role = 'staff';
  -- Lock staff before session, matching credential-change trigger lock order.
  select organization_id into v_org from public.staff
  where id = v_staff_id and active for update;
  if not found then
    raise exception 'Invalid staff session' using errcode = '42501';
  end if;
  perform 1 from private.app_sessions
  where token_hash = p_token_hash and staff_id = v_staff_id and expires_at > now() for share;
  if not found or public.validate_app_session(p_token_hash) is null then
    raise exception 'Invalid staff session' using errcode = '42501';
  end if;

  if p_action = 'call-next' and p_ticket_id is null then
    v_service_id := p_service_id;
  elsif p_action in ('complete', 'skip') and p_service_id is null then
    select service_id into v_service_id from public.queue_tickets
    where id = p_ticket_id and organization_id = v_org and served_by_staff_id = v_staff_id;
  else
    raise exception 'Invalid queue action' using errcode = '22023';
  end if;

  perform a.id from public.staff_assignments a
  join public.services s on s.id = a.service_id and s.active
  join public.locations l on l.id = a.location_id and l.active
  where a.staff_id = v_staff_id and a.organization_id = v_org and a.service_id = v_service_id
  for share of a, s, l;
  if not found then
    raise exception 'Action not permitted for this assignment' using errcode = '42501';
  end if;

  if p_action = 'call-next' then
    return query select * from public.call_next_ticket(v_service_id, v_staff_id);
  elsif p_action = 'complete' then
    return query select * from public.complete_queue_ticket(p_ticket_id, v_staff_id);
  else
    return query select * from public.skip_queue_ticket(p_ticket_id, v_staff_id);
  end if;
end;
$$;
revoke all on function public.perform_staff_queue_action(text,text,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.perform_staff_queue_action(text,text,uuid,uuid) to service_role;
