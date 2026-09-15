-- Work sessions outlive browser connections and the login that opened them.
-- Existing presence is unknown until a genuine authenticated heartbeat arrives.
alter table public.counter_sessions add column last_seen_at timestamptz;
alter table public.counter_sessions alter column last_seen_at set default clock_timestamp();
drop trigger app_session_counter_release on private.app_sessions;
drop function private.close_revoked_idle_counters();

create or replace view private.live_counter_sessions as
select cs.* from public.counter_sessions cs
join public.counters c on c.id=cs.counter_id and c.active and c.archived_at is null
join public.staff st on st.id=cs.staff_id and st.active and st.archived_at is null
join public.services s on s.id=cs.service_id and s.active and s.archived_at is null
join public.locations l on l.id=cs.location_id and l.active and l.archived_at is null
where cs.ended_at is null and exists(select 1 from public.staff_assignments sa
  where sa.staff_id=cs.staff_id and sa.organization_id=cs.organization_id
    and sa.location_id=cs.location_id and sa.service_id=cs.service_id);

create or replace function public.manage_staff_counter(p_token_hash text,p_action text,p_location_id uuid default null,p_service_id uuid default null,p_counter_id uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_staff public.staff; v_cs public.counter_sessions; v_id uuid;
begin
  v_staff:=private.require_counter_staff(p_token_hash);
  if p_action is null or p_action not in ('start','end') then raise exception 'Invalid action' using errcode='22023'; end if;
  if exists(select 1 from public.queue_tickets where served_by_staff_id=v_staff.id and status='SERVING') then
    raise exception 'Finish current ticket first' using errcode='23514';
  end if;
  if p_action='end' then
    if p_location_id is not null or p_service_id is not null or p_counter_id is not null then raise exception 'Invalid fields' using errcode='22023'; end if;
    select * into v_cs from public.counter_sessions where staff_id=v_staff.id and ended_at is null;
    if not found then return null; end if;
    perform 1 from public.counters where id=v_cs.counter_id for update;
    update public.counter_sessions set ended_at=greatest(clock_timestamp(),started_at) where id=v_cs.id and ended_at is null;
    return v_cs.id;
  end if;
  perform 1 from public.staff_assignments a
    join public.services s on s.id=a.service_id and s.active
    join public.locations l on l.id=a.location_id and l.active
    where a.staff_id=v_staff.id and a.organization_id=v_staff.organization_id
      and a.location_id=p_location_id and a.service_id=p_service_id for share of a,s,l;
  if not found then raise exception 'Assignment not permitted' using errcode='42501'; end if;
  perform 1 from public.counters where id=p_counter_id and organization_id=v_staff.organization_id and location_id=p_location_id and active for update;
  if not found then raise exception 'Counter unavailable' using errcode='P0002'; end if;
  -- Durable sessions require explicit end/release, regardless of auth expiry.
  insert into public.counter_sessions(organization_id,location_id,service_id,counter_id,staff_id,auth_token_hash)
    values(v_staff.organization_id,p_location_id,p_service_id,p_counter_id,v_staff.id,p_token_hash) returning id into v_id;
  return v_id;
end;
$$;

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
    -- Current request authentication is locked by require_counter_staff;
    -- counter ownership is durable and independent of the initiating login.
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
create or replace function public.get_staff_counter_state(p_token_hash text,p_location_id uuid default null,p_service_id uuid default null)
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
      from public.counter_sessions cs join public.counters c on c.id=cs.counter_id and c.archived_at is null
      where cs.staff_id=v_staff and cs.organization_id=v_org and cs.ended_at is null),
    'availableCounters',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) order by c.name,c.id)
      from public.counters c where c.organization_id=v_org and c.location_id=p_location_id and c.active and c.archived_at is null
      and not exists(select 1 from public.counter_sessions cs where cs.counter_id=c.id and cs.ended_at is null)), '[]'::jsonb)
  );
end;
$$;

create or replace function public.get_manager_counter_operations(p_token_hash text,p_location_id uuid,p_include_archived boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_l public.locations; v_now timestamptz:=statement_timestamp();
begin
  v_l:=private.require_manager_location(p_token_hash,p_location_id);
  return jsonb_build_object(
    'observedAt',v_now,'locationTimezone',v_l.timezone,
    'servingTickets',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'number',t.queue_number,
      'staffId',t.served_by_staff_id,'staffName',st.name,'serviceName',s.name,'counterName',t.counter_name,'startedAt',t.started_at) order by t.started_at,t.id)
      from public.queue_tickets t join public.staff st on st.id=t.served_by_staff_id join public.services s on s.id=t.service_id
      where t.organization_id=v_l.organization_id and t.location_id=v_l.id and t.status='SERVING'),'[]'::jsonb),
    'counters',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'active',c.active,'archived',c.archived_at is not null,
      'sessionId',cs.id,'lastSeenAt',cs.last_seen_at,'staffId',st.id,'staffName',st.name,'serviceName',s.name,
      'operational',exists(select 1 from private.live_counter_sessions live where live.id=cs.id),
      'ticketId',t.id,'ticketStartedAt',t.started_at,'ticketNumber',t.queue_number,'startedAt',cs.started_at) order by c.name,c.id)
      from public.counters c left join public.counter_sessions cs on cs.counter_id=c.id and cs.ended_at is null
      left join public.staff st on st.id=cs.staff_id left join public.services s on s.id=cs.service_id
      left join public.queue_tickets t on t.counter_session_id=cs.id and t.status='SERVING'
      where c.organization_id=v_l.organization_id and c.location_id=v_l.id and (p_include_archived or c.archived_at is null)),'[]'::jsonb),
    'services',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'active',s.active,'archived',s.archived_at is not null,
      'activeCounters',(select count(*) from private.live_counter_sessions cs where cs.service_id=s.id),
      'waiting',q.waiting,'serving',q.serving,'servedToday',q.served) order by s.name,s.id)
      from public.services s cross join lateral (select count(*) filter(where t.status='WAITING') as waiting,
        count(*) filter(where t.status='SERVING') as serving,
        count(*) filter(where t.status='COMPLETED' and t.completed_at>=private.analytics_range_start('today',v_l.timezone,v_now)
          and t.completed_at<=v_now) as served
        from public.queue_tickets t where t.organization_id=v_l.organization_id and t.location_id=v_l.id and t.service_id=s.id) q
      where s.organization_id=v_l.organization_id and s.location_id=v_l.id and (p_include_archived or s.archived_at is null)),'[]'::jsonb)
  );
end;
$$;



create function public.heartbeat_staff_counter(p_token_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_staff public.staff; v_cs public.counter_sessions;
begin
  v_staff:=private.require_counter_staff(p_token_hash);
  select * into v_cs from private.live_counter_sessions where staff_id=v_staff.id;
  if not found then return null; end if;
  -- Identity and current permissions are server-derived. Never start/reopen a session.
  update public.counter_sessions set last_seen_at=clock_timestamp()
    where id=v_cs.id and ended_at is null
      and (last_seen_at is null or last_seen_at < clock_timestamp()-interval '20 seconds');
  return v_cs.id;
end;
$$;

-- Presence changes invalidate only the manager location, not every customer
-- and staff queue. Time passing is rendered locally and covered by polling.
create or replace function private.broadcast_counter_change() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if TG_TABLE_NAME='counter_sessions' and TG_OP='UPDATE' then
    if (to_jsonb(new)-'last_seen_at'-'auth_token_hash')=(to_jsonb(old)-'last_seen_at'-'auth_token_hash') then
      if new.last_seen_at is distinct from old.last_seen_at then
        begin
          perform realtime.send('{}'::jsonb,'queue_changed','queue:location:'||new.location_id,true);
        exception when others then raise log 'Presence notification unavailable: %', SQLSTATE;
        end;
      end if;
      return null;
    end if;
  end if;
  if TG_OP<>'DELETE' then perform private.counter_signal(new.location_id); end if;
  if TG_OP='DELETE' then perform private.counter_signal(old.location_id); end if;
  if TG_OP='UPDATE' and old.location_id is distinct from new.location_id then perform private.counter_signal(old.location_id); end if;
  return null;
end;
$$;
revoke all on function public.heartbeat_staff_counter(text) from public,anon,authenticated,service_role;
grant execute on function public.heartbeat_staff_counter(text) to service_role;
