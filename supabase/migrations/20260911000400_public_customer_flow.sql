-- Public HTTP endpoints call these functions only through the trusted server.
-- Existing queue mutation functions, grants and numbering are unchanged.
create table private.customer_join_requests (
  key_hash text primary key check (key_hash ~ '^[a-f0-9]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  ticket_id uuid references public.queue_tickets(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
create index customer_join_requests_created_idx on private.customer_join_requests(created_at);
alter table private.customer_join_requests enable row level security;
revoke all on private.customer_join_requests from public, anon, authenticated, service_role;

create or replace function public.get_public_queue_location(p_slug text)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'name', l.name, 'organizationName', o.name, 'slug', l.slug,
    'services', coalesce((select jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'code', s.queue_prefix,
      'waitingCount', (select count(*) from public.queue_tickets t where t.service_id = s.id
        and t.location_id = l.id and t.organization_id = l.organization_id and t.status = 'WAITING')
    ) order by s.name, s.id) from public.services s
      where s.location_id = l.id and s.organization_id = l.organization_id and s.active), '[]'::jsonb)
  ) from public.locations l join public.organizations o on o.id = l.organization_id
    where l.slug = p_slug and l.active
$$;

create function public.get_public_queue_ticket(p_token uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  -- One statement/snapshot for ticket status and the changing count. Keep the
  -- existing token lookup contract; expose fewer fields than its internal DTO.
  select jsonb_build_object(
    'queueNumber', safe.queue_number, 'service', s.name, 'location', l.name,
    'status', safe.status, 'joinedAt', safe.joined_at, 'calledAt', safe.started_at,
    'completedAt', safe.completed_at, 'skippedAt', safe.skipped_at,
    'peopleAhead', case when safe.status = 'WAITING' then (
      select count(*) from public.queue_tickets ahead
      where ahead.organization_id = t.organization_id and ahead.location_id = t.location_id
        and ahead.service_id = t.service_id and ahead.status = 'WAITING'
        and (ahead.joined_at, ahead.id) < (t.joined_at, t.id)
    ) else null end
  ) from public.get_queue_ticket_by_token(p_token) safe
    join public.queue_tickets t on t.ticket_token = safe.ticket_token
    join public.services s on s.id = t.service_id and s.organization_id = t.organization_id
    join public.locations l on l.id = t.location_id and l.organization_id = t.organization_id
$$;

create function public.join_public_queue(
  p_slug text, p_service_id uuid, p_customer_name text, p_key_hash text, p_payload_hash text
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_request private.customer_join_requests;
  v_location_id uuid;
  v_ticket public.queue_tickets;
  v_token uuid;
begin
  if p_customer_name is null or length(p_customer_name) not between 1 and 200
    or p_customer_name !~ '[^[:space:]]' or p_customer_name ~ '[[:cntrl:]]' then
    raise exception 'Invalid customer name' using errcode = '22023';
  end if;
  -- Competing copies of the same request serialize here. A failed ticket
  -- creation rolls back this row as well as the existing daily counter update.
  insert into private.customer_join_requests(key_hash, payload_hash)
    values (p_key_hash, p_payload_hash) on conflict (key_hash) do nothing;
  select * into v_request from private.customer_join_requests
    where key_hash = p_key_hash for update;
  if v_request.payload_hash <> p_payload_hash then
    raise exception 'Request key already used' using errcode = 'P0001';
  end if;
  if v_request.ticket_id is not null then
    select ticket_token into v_token from public.queue_tickets where id = v_request.ticket_id;
    return v_token;
  end if;
  select id into v_location_id from public.locations where slug = p_slug and active for share;
  if not found then raise exception 'Location unavailable' using errcode = 'P0002'; end if;
  -- This existing function verifies/locks active service + location + tenant,
  -- allocates the number, and generates the random bearer token atomically.
  v_ticket := public.create_queue_ticket(v_location_id, p_service_id, p_customer_name);
  update private.customer_join_requests set ticket_id = v_ticket.id where key_hash = p_key_hash;
  return v_ticket.ticket_token;
end;
$$;

create function public.prune_customer_join_requests()
returns void language sql security definer set search_path = ''
as $$ delete from private.customer_join_requests where created_at < now() - interval '24 hours' $$;

revoke all on function public.get_public_queue_location(text), public.get_public_queue_ticket(uuid),
  public.join_public_queue(text,uuid,text,text,text), public.prune_customer_join_requests()
  from public, anon, authenticated, service_role;
grant execute on function public.get_public_queue_location(text), public.get_public_queue_ticket(uuid),
  public.join_public_queue(text,uuid,text,text,text), public.prune_customer_join_requests() to service_role;
