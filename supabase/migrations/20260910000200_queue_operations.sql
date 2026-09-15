-- These are server-only RPCs. Execute permission is the trust boundary:
-- the application must derive p_staff_id from a verified staff session.
-- Never forward a browser-supplied staff ID as authenticated identity.

create function public.create_queue_ticket(
  p_location_id uuid, p_service_id uuid, p_customer_name text
)
returns public.queue_tickets
language plpgsql security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_prefix text;
  v_timezone text;
  v_joined_at timestamptz;
  v_date date;
  v_number bigint;
  v_ticket public.queue_tickets;
begin
  if p_customer_name is null or length(btrim(p_customer_name)) not between 1 and 200
      or p_customer_name !~ '[^[:space:]]' then
    raise exception 'Customer name must contain 1 to 200 characters' using errcode = '22023';
  end if;

  select s.organization_id, s.queue_prefix, l.timezone
    into v_organization_id, v_prefix, v_timezone
  from public.services s
  join public.locations l on l.id = s.location_id and l.organization_id = s.organization_id
  where s.id = p_service_id and l.id = p_location_id and s.active and l.active
  for share of s, l;
  if not found then
    raise exception 'Active location/service combination not found' using errcode = '22023';
  end if;

  v_joined_at := clock_timestamp();
  v_date := (v_joined_at at time zone v_timezone)::date;
  insert into public.service_daily_counters as counters
    (organization_id, location_id, service_id, queue_date, last_number)
  values (v_organization_id, p_location_id, p_service_id, v_date, 1)
  on conflict (service_id, queue_date)
  do update set last_number = counters.last_number + 1
  returning last_number into v_number;

  -- Counter and ticket share one transaction: failed creation rolls both back.
  insert into public.queue_tickets
    (organization_id, location_id, service_id, queue_date, queue_sequence,
     queue_prefix, customer_name, joined_at)
  values
    (v_organization_id, p_location_id, p_service_id, v_date, v_number,
     v_prefix, btrim(p_customer_name), v_joined_at)
  returning * into v_ticket;
  return v_ticket;
end;
$$;

create function public.call_next_ticket(p_service_id uuid, p_staff_id uuid)
returns setof public.queue_tickets
language plpgsql security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_ticket_id uuid;
begin
  -- Serialize actions from the same staff member, including double clicks.
  select organization_id into v_organization_id
  from public.staff where id = p_staff_id and active for update;
  if not found then
    raise exception 'Active staff member not found' using errcode = '42501';
  end if;

  perform a.id
  from public.staff_assignments a
  join public.services s on s.id = a.service_id and s.organization_id = a.organization_id
  join public.locations l on l.id = a.location_id and l.organization_id = a.organization_id
  where a.staff_id = p_staff_id and a.service_id = p_service_id
    and a.organization_id = v_organization_id and s.active and l.active
  for share of a, s, l;
  if not found then
    raise exception 'Staff member is not assigned to this active service' using errcode = '42501';
  end if;

  if exists (select 1 from public.queue_tickets
    where served_by_staff_id = p_staff_id and status = 'SERVING') then
    raise exception 'Complete or skip the current ticket before calling next' using errcode = '23514';
  end if;

  select id into v_ticket_id from public.queue_tickets
  where service_id = p_service_id and organization_id = v_organization_id and status = 'WAITING'
  order by joined_at, id
  limit 1 for update skip locked;
  if not found then
    return;
  end if;

  return query update public.queue_tickets
    set status = 'SERVING', started_at = greatest(clock_timestamp(), joined_at),
        served_by_staff_id = p_staff_id
    where id = v_ticket_id and status = 'WAITING'
    returning *;
end;
$$;

create function public.complete_queue_ticket(p_ticket_id uuid, p_staff_id uuid)
returns public.queue_tickets
language plpgsql security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_ticket public.queue_tickets;
begin
  select organization_id into v_organization_id
  from public.staff where id = p_staff_id and active for share;
  if not found then
    raise exception 'Active staff member not found' using errcode = '42501';
  end if;

  -- The conditional UPDATE acquires a row lock and rechecks after contention.
  update public.queue_tickets
    set status = 'COMPLETED', completed_at = greatest(clock_timestamp(), started_at)
    where id = p_ticket_id and organization_id = v_organization_id
      and served_by_staff_id = p_staff_id and status = 'SERVING'
    returning * into v_ticket;
  if not found then
    raise exception 'No serving ticket owned by this staff member' using errcode = 'P0002';
  end if;
  return v_ticket;
end;
$$;

create function public.skip_queue_ticket(p_ticket_id uuid, p_staff_id uuid)
returns public.queue_tickets
language plpgsql security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_ticket public.queue_tickets;
begin
  select organization_id into v_organization_id
  from public.staff where id = p_staff_id and active for share;
  if not found then
    raise exception 'Active staff member not found' using errcode = '42501';
  end if;

  -- MVP skip: only the staff member's own SERVING ticket can be skipped.
  update public.queue_tickets
    set status = 'SKIPPED', skipped_at = greatest(clock_timestamp(), started_at)
    where id = p_ticket_id and organization_id = v_organization_id
      and served_by_staff_id = p_staff_id and status = 'SERVING'
    returning * into v_ticket;
  if not found then
    raise exception 'No serving ticket owned by this staff member' using errcode = 'P0002';
  end if;
  return v_ticket;
end;
$$;

create function public.get_queue_ticket_by_token(p_ticket_token uuid)
returns table (
  ticket_token uuid, queue_number text, customer_name text,
  location_id uuid, service_id uuid, status text,
  joined_at timestamptz, started_at timestamptz, completed_at timestamptz, skipped_at timestamptz
)
language sql stable security definer
set search_path = ''
as $$
  select t.ticket_token, t.queue_number, t.customer_name, t.location_id, t.service_id,
    t.status, t.joined_at, t.started_at, t.completed_at, t.skipped_at
  from public.queue_tickets t where t.ticket_token = p_ticket_token
$$;

revoke all on function public.create_queue_ticket(uuid, uuid, text),
  public.call_next_ticket(uuid, uuid), public.complete_queue_ticket(uuid, uuid),
  public.skip_queue_ticket(uuid, uuid), public.get_queue_ticket_by_token(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.create_queue_ticket(uuid, uuid, text),
  public.call_next_ticket(uuid, uuid), public.complete_queue_ticket(uuid, uuid),
  public.skip_queue_ticket(uuid, uuid), public.get_queue_ticket_by_token(uuid)
  to service_role;
