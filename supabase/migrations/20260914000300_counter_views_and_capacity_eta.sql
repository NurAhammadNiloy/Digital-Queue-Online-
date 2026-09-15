create function public.get_staff_counter_state(p_token_hash text,p_location_id uuid default null,p_service_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_identity jsonb; v_staff uuid; v_org uuid;
begin
  v_identity:=public.validate_app_session(p_token_hash);
  if v_identity is null or v_identity->>'role'<>'staff' then raise exception 'Access denied' using errcode='42501'; end if;
  v_staff:=(v_identity->>'id')::uuid; v_org:=(v_identity->>'organizationId')::uuid;
  if p_location_id is not null or p_service_id is not null then
    if not exists(select 1 from jsonb_array_elements(v_identity->'assignments') a
      where a->>'locationId'=p_location_id::text and a->>'serviceId'=p_service_id::text) then
      raise exception 'Assignment not permitted' using errcode='42501';
    end if;
  end if;
  return jsonb_build_object(
    'counterSession',(select jsonb_build_object('id',cs.id,'counterId',cs.counter_id,'counterName',c.name,
      'locationId',cs.location_id,'serviceId',cs.service_id,'startedAt',cs.started_at,
      'operational',exists(select 1 from private.live_counter_sessions live where live.id=cs.id))
      from public.counter_sessions cs join public.counters c on c.id=cs.counter_id
      where cs.staff_id=v_staff and cs.organization_id=v_org and cs.ended_at is null),
    'availableCounters',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) order by c.name,c.id)
      from public.counters c where c.organization_id=v_org and c.location_id=p_location_id and c.active
      and not exists(select 1 from public.counter_sessions cs where cs.counter_id=c.id and cs.ended_at is null
        and (exists(select 1 from private.app_sessions a where a.token_hash=cs.auth_token_hash and a.expires_at>now())
          or exists(select 1 from public.queue_tickets t where t.counter_session_id=cs.id and t.status='SERVING')))), '[]'::jsonb)
  );
end;
$$;

create function public.get_manager_counter_operations(p_token_hash text,p_location_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_l public.locations; v_now timestamptz:=statement_timestamp();
begin
  v_l:=private.require_manager_location(p_token_hash,p_location_id);
  return jsonb_build_object(
    'counters',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'active',c.active,
      'sessionId',cs.id,'staffName',st.name,'serviceName',s.name,
      'operational',exists(select 1 from private.live_counter_sessions live where live.id=cs.id),
      'ticketNumber',t.queue_number,'startedAt',cs.started_at) order by c.name,c.id)
      from public.counters c left join public.counter_sessions cs on cs.counter_id=c.id and cs.ended_at is null
      left join public.staff st on st.id=cs.staff_id left join public.services s on s.id=cs.service_id
      left join public.queue_tickets t on t.counter_session_id=cs.id and t.status='SERVING'
      where c.organization_id=v_l.organization_id and c.location_id=v_l.id),'[]'::jsonb),
    'services',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'active',s.active,
      'activeCounters',(select count(*) from private.live_counter_sessions cs where cs.service_id=s.id),
      'waiting',q.waiting,'serving',q.serving,'servedToday',q.served) order by s.name,s.id)
      from public.services s cross join lateral (select count(*) filter(where t.status='WAITING') as waiting,
        count(*) filter(where t.status='SERVING') as serving,
        count(*) filter(where t.status='COMPLETED' and t.completed_at>=private.analytics_range_start('today',v_l.timezone,v_now)
          and t.completed_at<=v_now) as served
        from public.queue_tickets t where t.organization_id=v_l.organization_id and t.location_id=v_l.id and t.service_id=s.id) q
      where s.organization_id=v_l.organization_id and s.location_id=v_l.id),'[]'::jsonb)
  );
end;
$$;

create function private.service_average_seconds(p_org uuid,p_location uuid,p_service uuid)
returns numeric language sql stable security definer set search_path='' as $$
  select coalesce((select case when count(*)>=5 then avg(sample.seconds) end from (
    select extract(epoch from (t.completed_at-t.started_at)) as seconds from public.queue_tickets t
    where t.organization_id=s.organization_id and t.location_id=s.location_id and t.service_id=s.id
      and t.status='COMPLETED' and isfinite(t.started_at) and isfinite(t.completed_at)
      and t.completed_at>t.started_at and t.completed_at>=now()-interval '30 days' and t.completed_at<=now()
    order by t.completed_at desc,t.id desc limit 100
  ) sample),case when s.default_service_minutes>0 then s.default_service_minutes::numeric*60 end)
  from public.services s where s.organization_id=p_org and s.location_id=p_location and s.id=p_service
$$;

create function private.queue_wait_seconds(p_org uuid,p_location uuid,p_service uuid,p_ahead bigint)
returns numeric language plpgsql stable security definer set search_path='' as $$
declare v_duration numeric; v_lanes numeric[]; v_low numeric; v_high numeric; v_mid numeric; v_calls numeric;
begin
  if p_ahead is null or p_ahead<0 then return null; end if;
  v_duration:=ceil(private.service_average_seconds(p_org,p_location,p_service));
  if v_duration is null or v_duration<=0 then return null; end if;
  select array_agg(case when t.id is null then 0 else
    -- Overdue work has no known end. Reserve another average duration rather
    -- than claiming an occupied lane is immediately available.
    case when extract(epoch from (statement_timestamp()-t.started_at))>=v_duration then v_duration
      else ceil(greatest(0,v_duration-extract(epoch from (statement_timestamp()-t.started_at)))) end end)
    into v_lanes from private.live_counter_sessions cs
    left join public.queue_tickets t on t.counter_session_id=cs.id and t.status='SERVING'
    where cs.organization_id=p_org and cs.location_id=p_location and cs.service_id=p_service;
  if coalesce(array_length(v_lanes,1),0)=0 then return null; end if;
  select min(lane) into v_low from unnest(v_lanes) lane;
  v_high:=v_low+p_ahead::numeric*v_duration;
  -- Find the (people-ahead + 1)th available slot across independent lanes.
  -- Binary search avoids one iteration per queued customer for long queues.
  while v_low<v_high loop
    v_mid:=floor((v_low+v_high)/2);
    select sum(case when v_mid>=lane then floor((v_mid-lane)/v_duration)+1 else 0 end)
      into v_calls from unnest(v_lanes) lane;
    if v_calls>p_ahead then v_high:=v_mid; else v_low:=v_mid+1; end if;
  end loop;
  return v_low;
end;
$$;
create or replace function private.queue_wait_minutes(p_organization_id uuid,p_location_id uuid,p_service_id uuid,p_people_ahead bigint)
returns numeric language sql stable security definer set search_path='' as $$
  select ceil(private.queue_wait_seconds(p_organization_id,p_location_id,p_service_id,p_people_ahead)/60)
$$;

create or replace function public.get_public_queue_ticket(p_token uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  with view as materialized (
    select t.queue_number,s.name as service,l.name as location,l.slug,l.timezone,t.status,
      t.joined_at,t.started_at,t.completed_at,t.skipped_at,t.cancelled_at,t.counter_name,
      t.organization_id,t.location_id,t.service_id,
      case when t.status='WAITING' then (select count(*) from public.queue_tickets ahead
        where ahead.organization_id=t.organization_id and ahead.location_id=t.location_id and ahead.service_id=t.service_id
          and ahead.status='WAITING' and (ahead.joined_at,ahead.id)<(t.joined_at,t.id)) end as people_ahead
    from public.queue_tickets t join public.services s on s.id=t.service_id and s.organization_id=t.organization_id
      join public.locations l on l.id=t.location_id and l.organization_id=t.organization_id where t.ticket_token=p_token
  ), estimate as materialized (
    select v.*,case when status='WAITING' then private.queue_wait_seconds(organization_id,location_id,service_id,people_ahead) end as seconds from view v
  ) select jsonb_build_object('queueNumber',queue_number,'service',service,'location',location,'locationSlug',slug,
    'locationTimezone',timezone,'status',status,'joinedAt',joined_at,'calledAt',started_at,'completedAt',completed_at,
    'skippedAt',skipped_at,'cancelledAt',cancelled_at,'counterName',counter_name,'peopleAhead',people_ahead,
    'estimatedWaitMinutes',ceil(seconds/60),
    'estimatedCallAt',case when seconds is not null then statement_timestamp()+make_interval(secs=>seconds::double precision) end)
  from estimate
$$;

-- Active configuration changes also change capacity. No queue/customer data
-- is carried in these signals, and existing scoped SSE guards remain intact.
create function private.broadcast_capacity_config() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if TG_TABLE_NAME='locations' then perform private.counter_signal(new.id);
  else perform private.counter_signal(new.location_id); end if;
  return null;
end;
$$;
create trigger location_capacity_signal after update of active on public.locations for each row execute function private.broadcast_capacity_config();
create trigger service_capacity_signal after update of active,default_service_minutes on public.services for each row execute function private.broadcast_capacity_config();
revoke all on function private.service_average_seconds(uuid,uuid,uuid),private.queue_wait_seconds(uuid,uuid,uuid,bigint),private.broadcast_capacity_config(),private.queue_wait_minutes(uuid,uuid,uuid,bigint) from public,anon,authenticated,service_role;
revoke all on function public.get_staff_counter_state(text,uuid,uuid),public.get_manager_counter_operations(text,uuid),public.get_public_queue_ticket(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_staff_counter_state(text,uuid,uuid),public.get_manager_counter_operations(text,uuid),public.get_public_queue_ticket(uuid) to service_role;
