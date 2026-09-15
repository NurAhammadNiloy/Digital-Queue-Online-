-- Never retain the old organization-wide reporting overloads.
drop function public.get_manager_dashboard(text);
drop function public.get_manager_analytics(text,text);

-- PostgreSQL accepts POSIX offsets in AT TIME ZONE. Locations must instead use
-- a named IANA zone (including UTC and tzdb aliases), preserving DST rules.
do $$
begin
  if exists (select 1 from public.locations l where not exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name=l.timezone and z.name !~ '^(posix|right)/'
  )) then raise exception 'Existing locations require valid IANA timezones before this migration'; end if;
end;
$$;
create function private.validate_location_timezone() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name=new.timezone and name !~ '^(posix|right)/') then
    raise exception 'A valid IANA timezone is required' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function private.validate_location_timezone() from public,anon,authenticated,service_role;
create trigger locations_iana_timezone before insert or update of timezone on public.locations
for each row execute function private.validate_location_timezone();

create function private.require_manager_location(p_token_hash text,p_location_id uuid)
returns public.locations language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_location public.locations;
begin
  v_org := private.require_manager_organization(p_token_hash);
  if p_location_id is null then raise exception 'Select a location' using errcode='22023'; end if;
  select * into v_location from public.locations where id=p_location_id and organization_id=v_org for share;
  if not found then raise exception 'Location not found' using errcode='P0002'; end if;
  return v_location;
end;
$$;
revoke all on function private.require_manager_location(text,uuid) from public,anon,authenticated,service_role;

create function public.get_manager_dashboard(p_token_hash text,p_location_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_location public.locations; v_as_of timestamptz := statement_timestamp();
begin
  v_location := private.require_manager_location(p_token_hash,p_location_id);
  return (select jsonb_build_object(
    'waitingNow',count(*) filter(where status='WAITING'),
    'currentlyServing',count(*) filter(where status='SERVING'),
    'servedToday',count(*) filter(where status='COMPLETED'
      and completed_at >= private.analytics_range_start('today',v_location.timezone,v_as_of) and completed_at <= v_as_of)
  ) from public.queue_tickets where organization_id=v_location.organization_id and location_id=v_location.id);
end;
$$;

create function public.get_manager_analytics(p_token_hash text,p_location_id uuid,p_range text default 'today')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_location public.locations; v_as_of timestamptz := statement_timestamp(); v_start timestamptz;
begin
  v_location := private.require_manager_location(p_token_hash,p_location_id);
  if p_range is null then raise exception 'Invalid analytics range' using errcode='22023'; end if;
  v_start := private.analytics_range_start(p_range,v_location.timezone,v_as_of);
  return (
    with completed as materialized (
      select t.service_id,t.served_by_staff_id,
        extract(epoch from (t.started_at-t.joined_at)) as wait_seconds,
        extract(epoch from (t.completed_at-t.started_at)) as service_seconds
      from public.queue_tickets t
      where t.organization_id=v_location.organization_id and t.location_id=v_location.id and t.status='COMPLETED'
        and t.completed_at >= v_start and t.completed_at <= v_as_of
    ), by_service as (
      select service_id,count(*) as served_count,avg(wait_seconds) as wait_seconds,avg(service_seconds) as service_seconds
      from completed group by service_id
    ), by_staff as (
      select served_by_staff_id,count(*) as served_count,avg(service_seconds) as service_seconds
      from completed group by served_by_staff_id
    )
    select jsonb_build_object(
      'asOf',v_as_of,'servedCount',(select count(*) from completed),
      'averageWaitSeconds',(select avg(wait_seconds) from completed),
      'averageServiceSeconds',(select avg(service_seconds) from completed),
      'services',(select coalesce(jsonb_agg(jsonb_build_object(
        'id',s.id,'name',s.name,'locationName',v_location.name,'active',s.active and v_location.active,
        'servedCount',coalesce(a.served_count,0),'averageWaitSeconds',a.wait_seconds,'averageServiceSeconds',a.service_seconds
      ) order by s.name,s.id),'[]'::jsonb)
        from public.services s left join by_service a on a.service_id=s.id
        where s.organization_id=v_location.organization_id and s.location_id=v_location.id),
      -- Membership in historical reports is based on ticket attribution, never
      -- current assignments. Former staff retain all their completed history.
      'staff',(select coalesce(jsonb_agg(jsonb_build_object(
        'id',s.id,'name',s.name,'active',s.active,'servedCount',a.served_count,'averageServiceSeconds',a.service_seconds
      ) order by s.name,s.id),'[]'::jsonb)
        from by_staff a join public.staff s on s.id=a.served_by_staff_id and s.organization_id=v_location.organization_id)
    )
  );
end;
$$;
revoke all on function public.get_manager_dashboard(text,uuid),public.get_manager_analytics(text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.get_manager_dashboard(text,uuid),public.get_manager_analytics(text,uuid,text) to service_role;

-- Extend the existing configuration transaction; omitted timezone preserves existing values.
create or replace function public.manage_location_config(p_token_hash text,p_operation text,
  p_location_id uuid default null,p_service_id uuid default null,p_values jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_org uuid; v_id uuid; v_name text; v_active boolean;
begin
  v_org := private.require_manager_organization(p_token_hash);
  if p_operation is null or p_operation not in ('create-location','update-location','create-service','update-service')
    or p_values is null or jsonb_typeof(p_values)<>'object' then
    raise exception 'Invalid operation' using errcode='22023';
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
  if jsonb_typeof(p_values->'name') is distinct from 'string' or jsonb_typeof(p_values->'active') is distinct from 'boolean' then
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
        address=nullif(btrim(p_values->>'address'),''),active=v_active,timezone=coalesce(p_values->>'timezone',timezone) where id=p_location_id and organization_id=v_org returning id into v_id;
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
