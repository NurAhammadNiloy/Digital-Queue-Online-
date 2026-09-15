-- Preserve tickets, numbering and history. Cancellation is a terminal state.
alter table public.queue_tickets add column cancelled_at timestamptz;
alter table public.queue_tickets drop constraint queue_tickets_status_check;
alter table public.queue_tickets add constraint queue_tickets_status_check
  check (status in ('WAITING','SERVING','COMPLETED','SKIPPED','CANCELLED'));
alter table public.queue_tickets drop constraint queue_tickets_state_check;
alter table public.queue_tickets add constraint queue_tickets_state_check check (
  (status = 'WAITING' and started_at is null and served_by_staff_id is null
    and completed_at is null and skipped_at is null and cancelled_at is null) or
  (status = 'SERVING' and started_at is not null and served_by_staff_id is not null
    and completed_at is null and skipped_at is null and cancelled_at is null) or
  (status = 'COMPLETED' and started_at is not null and served_by_staff_id is not null
    and completed_at is not null and skipped_at is null and cancelled_at is null) or
  (status = 'SKIPPED' and started_at is not null and served_by_staff_id is not null
    and completed_at is null and skipped_at is not null and cancelled_at is null) or
  (status = 'CANCELLED' and started_at is null and served_by_staff_id is null
    and completed_at is null and skipped_at is null and cancelled_at is not null
    and isfinite(cancelled_at) and cancelled_at >= joined_at)
);

create or replace function public.get_public_queue_ticket(p_token uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  with view as materialized (
    select safe.queue_number, s.name as service, l.name as location,
      l.slug as location_slug, l.timezone as location_timezone, safe.status,
      safe.joined_at, safe.started_at, safe.completed_at, safe.skipped_at, t.cancelled_at,
      t.organization_id, t.location_id, t.service_id,
      case when safe.status = 'WAITING' then (
        select count(*) from public.queue_tickets ahead
        where ahead.organization_id = t.organization_id and ahead.location_id = t.location_id
          and ahead.service_id = t.service_id and ahead.status = 'WAITING'
          and (ahead.joined_at,ahead.id) < (t.joined_at,t.id)
      ) end as people_ahead
    from public.get_queue_ticket_by_token(p_token) safe
      join public.queue_tickets t on t.ticket_token = safe.ticket_token
      join public.services s on s.id = t.service_id and s.organization_id = t.organization_id
      join public.locations l on l.id = t.location_id and l.organization_id = t.organization_id
  )
  select jsonb_build_object(
    'queueNumber', v.queue_number, 'service', v.service, 'location', v.location,
    'locationSlug', v.location_slug, 'locationTimezone', v.location_timezone,
    'status', v.status, 'joinedAt', v.joined_at, 'calledAt', v.started_at,
    'completedAt', v.completed_at, 'skippedAt', v.skipped_at, 'cancelledAt', v.cancelled_at,
    'peopleAhead', v.people_ahead,
    'estimatedWaitMinutes', case when v.status = 'WAITING' then
      private.queue_wait_minutes(v.organization_id,v.location_id,v.service_id,v.people_ahead) end
  ) from view v
$$;

create function public.cancel_public_queue_ticket(p_token uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  -- This conditional UPDATE locks the ticket and rechecks WAITING after waiting
  -- for another transaction. CALL NEXT already locks/skips locked WAITING rows.
  update public.queue_tickets
    set status = 'CANCELLED', cancelled_at = greatest(clock_timestamp(), joined_at)
    where ticket_token = p_token and status = 'WAITING';
  if not found then
    if exists (select 1 from public.queue_tickets where ticket_token = p_token) then
      raise exception 'Ticket is no longer waiting.' using errcode = 'P0001';
    end if;
    raise exception 'Ticket not found.' using errcode = 'P0002';
  end if;
  -- The existing UPDATE trigger broadcasts scoped, data-free invalidations.
  -- Never alter counters or join retry records; a retry must retain its receipt.
  return public.get_public_queue_ticket(p_token);
end;
$$;

revoke all on function public.cancel_public_queue_ticket(uuid), public.get_public_queue_ticket(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.cancel_public_queue_ticket(uuid), public.get_public_queue_ticket(uuid)
  to service_role;
