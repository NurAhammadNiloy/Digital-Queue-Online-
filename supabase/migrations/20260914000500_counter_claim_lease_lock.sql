-- Keep counter lease validation atomic with queue claims from any staff login.
create or replace function public.perform_staff_queue_action(p_token_hash text,p_action text,p_service_id uuid default null,p_ticket_id uuid default null)
returns setof public.queue_tickets language plpgsql security definer set search_path='' as $$
declare v_staff public.staff; v_service uuid; v_cs public.counter_sessions; v_name text; v_ticket public.queue_tickets;
begin
  v_staff:=private.require_counter_staff(p_token_hash);
  if p_action='call-next' and p_ticket_id is null then v_service:=p_service_id;
  elsif p_action in ('complete','skip') and p_service_id is null then
    select service_id into v_service from public.queue_tickets where id=p_ticket_id and organization_id=v_staff.organization_id and served_by_staff_id=v_staff.id;
  else raise exception 'Invalid action' using errcode='22023'; end if;
  perform 1 from public.staff_assignments a join public.services s on s.id=a.service_id and s.active
    join public.locations l on l.id=a.location_id and l.active
    where a.staff_id=v_staff.id and a.organization_id=v_staff.organization_id and a.service_id=v_service for share of a,s,l;
  if not found then raise exception 'Assignment not permitted' using errcode='42501'; end if;
  if p_action='call-next' then
    select * into v_cs from private.live_counter_sessions where staff_id=v_staff.id and service_id=v_service;
    if not found then raise exception 'Start an active counter session for this service first' using errcode='23514'; end if;
    -- The request may use another valid login on the same staff account.
    -- Lock the counter's initiating auth lease too, so its expiry cleanup or
    -- revocation cannot race between capacity validation and the ticket claim.
    perform 1 from private.app_sessions where token_hash=v_cs.auth_token_hash
      and staff_id=v_staff.id and expires_at>now() for share;
    if not found then raise exception 'Start an active counter session for this service first' using errcode='23514'; end if;
    select name into v_name from public.counters where id=v_cs.counter_id and active for share;
    if not found then raise exception 'Counter unavailable' using errcode='23514'; end if;
    select * into v_ticket from public.call_next_ticket(v_service,v_staff.id);
    if v_ticket.id is null then return; end if;
    update public.queue_tickets set counter_id=v_cs.counter_id,counter_session_id=v_cs.id,counter_name=v_name
      where id=v_ticket.id returning * into v_ticket;
    return next v_ticket;
  elsif p_action='complete' then return query select * from public.complete_queue_ticket(p_ticket_id,v_staff.id);
  else return query select * from public.skip_queue_ticket(p_ticket_id,v_staff.id);
  end if;
end;
$$;

revoke all on function public.perform_staff_queue_action(text,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.perform_staff_queue_action(text,text,uuid,uuid) to service_role;
