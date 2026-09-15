-- Preserve existing queue, auth and history behavior; add explicit location lifecycle
-- and location timezone metadata for customer-facing timestamp formatting.
create or replace function public.manage_location_config(p_token_hash text,p_operation text,
  p_location_id uuid default null,p_service_id uuid default null,p_values jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_org uuid; v_id uuid; v_name text; v_active boolean;
begin
  v_org := private.require_manager_organization(p_token_hash);
  if p_operation is null or p_operation not in ('create-location','update-location','create-service','update-service',
    'activate-location','deactivate-location','delete-location')
    or p_values is null or jsonb_typeof(p_values)<>'object' then
    raise exception 'Invalid operation' using errcode='22023';
  end if;
  -- Lifecycle changes touch only active; deleting an empty location cannot
  -- cascade through services, assignments, tickets or numbering history.
  if p_operation in ('activate-location','deactivate-location','delete-location') then
    if p_service_id is not null or p_values <> '{}'::jsonb then
      raise exception 'Invalid lifecycle fields' using errcode='22023';
    end if;
    perform 1 from public.locations where id=p_location_id and organization_id=v_org for update;
    if not found then raise exception 'Location not found' using errcode='P0002'; end if;
    if p_operation='delete-location' then
      if exists(select 1 from public.services where location_id=p_location_id)
        or exists(select 1 from public.staff_assignments where location_id=p_location_id)
        or exists(select 1 from public.queue_tickets where location_id=p_location_id)
        or exists(select 1 from public.service_daily_counters where location_id=p_location_id) then
        raise exception 'Location has dependent data; deactivate it instead' using errcode='23503';
      end if;
      -- The row lock plus existing FK restrictions also protect against a
      -- concurrent service insert. Never delete dependent rows here.
      delete from public.locations where id=p_location_id and organization_id=v_org;
    else
      update public.locations set active=(p_operation='activate-location')
        where id=p_location_id and organization_id=v_org;
    end if;
    return p_location_id;
  end if;
  if p_operation='create-location' then
    if p_location_id is not null or p_service_id is not null then raise exception 'Invalid target' using errcode='22023'; end if;
  else
    -- Location ownership is checked independently of any client-supplied target.
    if p_operation='update-location' then
      perform 1 from public.locations where id=p_location_id and organization_id=v_org for update;
    else
      perform 1 from public.locations where id=p_location_id and organization_id=v_org for share;
    end if;
    if not found then raise exception 'Location not found' using errcode='P0002'; end if;
    if p_operation='update-location' and p_service_id is not null then raise exception 'Invalid target' using errcode='22023'; end if;
    if p_operation='update-service' then
      perform 1 from public.services where id=p_service_id and location_id=p_location_id and organization_id=v_org for update;
      if not found then raise exception 'Service not found' using errcode='P0002'; end if;
    elsif p_operation='create-service' and p_service_id is not null then
      raise exception 'Invalid target' using errcode='22023';
    end if;
  end if;
  if jsonb_typeof(p_values->'name') is distinct from 'string' or (jsonb_typeof(p_values->'active') is distinct from 'boolean'
      and not (p_operation='update-location' and not (p_values ? 'active'))) then
    raise exception 'Invalid fields' using errcode='22023';
  end if;
  v_name := btrim(p_values->>'name'); v_active := (p_values->>'active')::boolean;
  if length(v_name) not between 1 and 200 or v_name !~ '[^[:space:]]' then raise exception 'Invalid name' using errcode='22023'; end if;
  if p_operation in ('create-location','update-location') then
    if p_values - array['name','description','address','active','slug','timezone'] <> '{}'::jsonb
      or (p_operation='update-location' and p_values ? 'slug')
      or (p_values ? 'timezone' and jsonb_typeof(p_values->'timezone') is distinct from 'string')
      or (p_values ? 'description' and jsonb_typeof(p_values->'description') not in ('string','null'))
      or (p_values ? 'address' and jsonb_typeof(p_values->'address') not in ('string','null'))
      or length(p_values->>'description')>2000 or length(p_values->>'address')>500 then
      raise exception 'Invalid location fields' using errcode='22023';
    end if;
    if p_operation='create-location' then
      if jsonb_typeof(p_values->'slug') is distinct from 'string' then raise exception 'Invalid slug' using errcode='22023'; end if;
      insert into public.locations(organization_id,name,description,address,active,slug,timezone)
        values(v_org,v_name,nullif(btrim(p_values->>'description'),''),nullif(btrim(p_values->>'address'),''),v_active,p_values->>'slug',coalesce(p_values->>'timezone','UTC')) returning id into v_id;
    else
      update public.locations set name=v_name,description=nullif(btrim(p_values->>'description'),''),
        address=nullif(btrim(p_values->>'address'),''),active=coalesce(v_active,active),timezone=coalesce(p_values->>'timezone',timezone) where id=p_location_id and organization_id=v_org returning id into v_id;
    end if;
  else
    if p_values - array['name','queuePrefix','defaultServiceMinutes','active'] <> '{}'::jsonb
      or jsonb_typeof(p_values->'queuePrefix') is distinct from 'string'
      or upper(btrim(p_values->>'queuePrefix')) !~ '^[A-Z]{1,4}$'
      or jsonb_typeof(p_values->'defaultServiceMinutes') is distinct from 'number'
      or (p_values->>'defaultServiceMinutes') !~ '^[0-9]+$' then
      raise exception 'Invalid service fields' using errcode='22023';
    end if;
    if p_operation='create-service' then
      insert into public.services(organization_id,location_id,name,queue_prefix,default_service_minutes,active)
        values(v_org,p_location_id,v_name,upper(btrim(p_values->>'queuePrefix')),(p_values->>'defaultServiceMinutes')::integer,v_active) returning id into v_id;
    else
      update public.services set name=v_name,queue_prefix=upper(btrim(p_values->>'queuePrefix')),
        default_service_minutes=(p_values->>'defaultServiceMinutes')::integer,active=v_active
        where id=p_service_id and location_id=p_location_id and organization_id=v_org returning id into v_id;
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.get_public_queue_ticket(p_token uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  -- Status, people ahead and duration history share the same database snapshot.
  with view as materialized (
    select safe.queue_number, s.name as service, l.name as location, l.timezone as location_timezone, safe.status,
      safe.joined_at, safe.started_at, safe.completed_at, safe.skipped_at,
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
    'locationTimezone', v.location_timezone, 'status', v.status, 'joinedAt', v.joined_at, 'calledAt', v.started_at,
    'completedAt', v.completed_at, 'skippedAt', v.skipped_at, 'peopleAhead', v.people_ahead,
    'estimatedWaitMinutes', case when v.status = 'WAITING' then
      private.queue_wait_minutes(v.organization_id,v.location_id,v.service_id,v.people_ahead) end
  ) from view v
$$;

revoke all on function public.manage_location_config(text,text,uuid,uuid,jsonb),
  public.get_public_queue_ticket(uuid) from public,anon,authenticated,service_role;
grant execute on function public.manage_location_config(text,text,uuid,uuid,jsonb),
  public.get_public_queue_ticket(uuid) to service_role;
