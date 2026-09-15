-- Use the same identity-before-session lock order as existing manager/staff RPCs.
create function private.require_manager_organization(p_token_hash text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_manager uuid; v_org uuid;
begin
  select manager_user_id into v_manager from private.app_sessions where token_hash=p_token_hash and role='manager';
  select m.organization_id into v_org from public.managers m join auth.users u on u.id=m.user_id
    where m.user_id=v_manager for share of m,u;
  if not found then raise exception 'Manager authentication required' using errcode='42501'; end if;
  perform 1 from private.app_sessions where token_hash=p_token_hash and role='manager' and expires_at>now() for share;
  if not found or public.validate_app_session(p_token_hash) is null then
    raise exception 'Manager authentication required' using errcode='42501';
  end if;
  return v_org;
end;
$$;
revoke all on function private.require_manager_organization(text) from public,anon,authenticated,service_role;

create function public.get_manager_dashboard(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_org uuid;
begin
  v_org := private.require_manager_organization(p_token_hash);
  return (select jsonb_build_object(
    'totalLocations',(select count(*) from public.locations where organization_id=v_org),
    'waitingNow',count(*) filter(where t.status='WAITING'),
    'currentlyServing',count(*) filter(where t.status='SERVING'),
    'servedToday',count(*) filter(where t.status='COMPLETED'
      and t.completed_at >= (date_trunc('day',now() at time zone l.timezone) at time zone l.timezone)
      and t.completed_at < ((date_trunc('day',now() at time zone l.timezone)+interval '1 day') at time zone l.timezone))
    ) from public.queue_tickets t join public.locations l on l.id=t.location_id and l.organization_id=t.organization_id
      where t.organization_id=v_org);
end;
$$;

create function public.manage_location_config(p_token_hash text,p_operation text,
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
    if p_values - array['name','description','address','active','slug'] <> '{}'::jsonb
      or (p_operation='update-location' and p_values ? 'slug')
      or (p_values ? 'description' and jsonb_typeof(p_values->'description') not in ('string','null'))
      or (p_values ? 'address' and jsonb_typeof(p_values->'address') not in ('string','null'))
      or length(p_values->>'description')>2000 or length(p_values->>'address')>500 then
      raise exception 'Invalid location fields' using errcode='22023';
    end if;
    if p_operation='create-location' then
      if jsonb_typeof(p_values->'slug') is distinct from 'string' then raise exception 'Invalid slug' using errcode='22023'; end if;
      insert into public.locations(organization_id,name,description,address,active,slug)
        values(v_org,v_name,nullif(btrim(p_values->>'description'),''),nullif(btrim(p_values->>'address'),''),v_active,p_values->>'slug') returning id into v_id;
    else
      update public.locations set name=v_name,description=nullif(btrim(p_values->>'description'),''),
        address=nullif(btrim(p_values->>'address'),''),active=v_active where id=p_location_id and organization_id=v_org returning id into v_id;
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
revoke all on function public.get_manager_dashboard(text),public.manage_location_config(text,text,uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.get_manager_dashboard(text),public.manage_location_config(text,text,uuid,uuid,jsonb) to service_role;
