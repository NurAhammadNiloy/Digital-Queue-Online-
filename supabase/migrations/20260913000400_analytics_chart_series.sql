-- Add zero-filled chart buckets to the existing authorized analytics snapshot.
-- Existing summary/service/staff calculations are unchanged.
create or replace function public.get_manager_analytics(p_token_hash text,p_location_id uuid,p_range text default 'today')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_location public.locations; v_as_of timestamptz := statement_timestamp(); v_start timestamptz; v_bucket text;
begin
  v_location := private.require_manager_location(p_token_hash,p_location_id);
  if p_range is null then raise exception 'Invalid analytics range' using errcode='22023'; end if;
  v_start := private.analytics_range_start(p_range,v_location.timezone,v_as_of);
  v_bucket := case when p_range='today' then 'hour' when p_range='all' then 'month' else 'day' end;
  return (
    with completed as materialized (
      select t.service_id,t.served_by_staff_id,t.completed_at,
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
    , time_totals as (
      select case when v_bucket='hour' then date_bin(interval '1 hour',completed_at,v_start)
        else date_trunc(v_bucket,completed_at at time zone v_location.timezone) at time zone v_location.timezone end as bucket,
        count(*) as served_count
      from completed group by 1
    ), time_slots as (
      -- Elapsed-hour buckets keep repeated DST hours separate. Calendar-day
      -- and month buckets use local boundaries, including 23/25-hour days.
      select h as bucket from generate_series(
        case when v_bucket='hour' then v_start end,v_as_of,interval '1 hour') h
      union all
      select d at time zone v_location.timezone from generate_series(
        case when v_bucket='month' then (select date_trunc('month',min(completed_at) at time zone v_location.timezone) from completed)
          when v_bucket='day' then v_start at time zone v_location.timezone end,
        v_as_of at time zone v_location.timezone,
        case when v_bucket='month' then interval '1 month' else interval '1 day' end) d
    )
    select jsonb_build_object(
      'bucketUnit',v_bucket,
      'servedOverTime',(select coalesce(jsonb_agg(jsonb_build_object(
        'start',s.bucket,'servedCount',coalesce(t.served_count,0)) order by s.bucket),'[]'::jsonb)
        from time_slots s left join time_totals t on t.bucket=s.bucket),
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
revoke all on function public.get_manager_analytics(text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.get_manager_analytics(text,uuid,text) to service_role;
