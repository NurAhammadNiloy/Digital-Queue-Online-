-- Calendar boundaries are calculated in location time before conversion to UTC.
-- The explicit clock makes boundary/DST behavior testable without changing server time.
create function private.analytics_range_start(p_range text, p_timezone text, p_as_of timestamptz)
returns timestamptz language plpgsql stable set search_path = ''
as $$
begin
  case p_range
    when 'today' then return date_trunc('day',p_as_of at time zone p_timezone) at time zone p_timezone;
    when '7days' then return (date_trunc('day',p_as_of at time zone p_timezone)-interval '6 days') at time zone p_timezone;
    when 'month' then return date_trunc('month',p_as_of at time zone p_timezone) at time zone p_timezone;
    when 'all' then return '-infinity'::timestamptz;
    else raise exception 'Invalid analytics range' using errcode='22023';
  end case;
end;
$$;
revoke all on function private.analytics_range_start(text,text,timestamptz) from public,anon,authenticated,service_role;

create function public.get_manager_analytics(p_token_hash text,p_range text default 'today')
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_org uuid; v_as_of timestamptz := statement_timestamp();
begin
  v_org := private.require_manager_organization(p_token_hash);
  if p_range is null or p_range not in ('today','7days','month','all') then
    raise exception 'Invalid analytics range' using errcode='22023';
  end if;
  -- Aggregate the selected history once. No customer names, tokens or ticket
  -- records leave this function. Inactive configuration retains its history.
  return (
    with completed as materialized (
      select t.service_id,t.served_by_staff_id,
        extract(epoch from (t.started_at-t.joined_at)) as wait_seconds,
        extract(epoch from (t.completed_at-t.started_at)) as service_seconds
      from public.locations l join public.queue_tickets t
        on t.organization_id=l.organization_id and t.location_id=l.id
      where l.organization_id=v_org and t.status='COMPLETED'
        and t.completed_at >= private.analytics_range_start(p_range,l.timezone,v_as_of)
        and t.completed_at <= v_as_of
    ), by_service as (
      select service_id,count(*) as served_count,avg(wait_seconds) as wait_seconds,avg(service_seconds) as service_seconds
      from completed group by service_id
    ), by_staff as (
      select served_by_staff_id,count(*) as served_count,avg(service_seconds) as service_seconds
      from completed group by served_by_staff_id
    )
    select jsonb_build_object(
      'asOf',v_as_of,
      'averageWaitSeconds',(select avg(wait_seconds) from completed),
      'averageServiceSeconds',(select avg(service_seconds) from completed),
      'services',(select coalesce(jsonb_agg(jsonb_build_object(
        'id',s.id,'name',s.name,'locationName',l.name,'active',s.active and l.active,
        'servedCount',coalesce(a.served_count,0),'averageWaitSeconds',a.wait_seconds,'averageServiceSeconds',a.service_seconds
      ) order by l.name,s.name,s.id),'[]'::jsonb)
        from public.services s join public.locations l on l.id=s.location_id and l.organization_id=s.organization_id
        left join by_service a on a.service_id=s.id where s.organization_id=v_org),
      'staff',(select coalesce(jsonb_agg(jsonb_build_object(
        'id',s.id,'name',s.name,'active',s.active,'servedCount',coalesce(a.served_count,0),'averageServiceSeconds',a.service_seconds
      ) order by s.name,s.id),'[]'::jsonb)
        from public.staff s left join by_staff a on a.served_by_staff_id=s.id where s.organization_id=v_org)
    )
  );
end;
$$;
revoke all on function public.get_manager_analytics(text,text) from public,anon,authenticated,service_role;
grant execute on function public.get_manager_analytics(text,text) to service_role;
