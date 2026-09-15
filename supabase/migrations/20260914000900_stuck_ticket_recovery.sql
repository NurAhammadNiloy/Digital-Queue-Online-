-- Manager recovery is restricted to SERVING tickets without an operational
-- attached counter session. Presence/auth expiry alone never qualifies.
create function public.resolve_stuck_serving_ticket(p_token_hash text,p_location_id uuid,p_ticket_id uuid,p_action text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_location public.locations; v_staff uuid; v_ticket public.queue_tickets;
begin
  v_location:=private.require_manager_location(p_token_hash,p_location_id);
  if p_action is null or p_action not in ('skip','complete') then
    raise exception 'Invalid recovery action' using errcode='22023';
  end if;
  select served_by_staff_id into v_staff from public.queue_tickets
    where id=p_ticket_id and organization_id=v_location.organization_id and location_id=v_location.id;
  if not found then raise exception 'Ticket not found' using errcode='P0002'; end if;
  -- Serialize with staff queue/session/assignment actions; NOWAIT avoids lock
  -- inversion with existing manager configuration changes. Caller can refresh.
  perform 1 from public.staff where id=v_staff and organization_id=v_location.organization_id for update nowait;
  select * into v_ticket from public.queue_tickets
    where id=p_ticket_id and organization_id=v_location.organization_id and location_id=v_location.id for update nowait;
  if not found then raise exception 'Ticket not found' using errcode='P0002'; end if;
  if v_ticket.status<>'SERVING' then raise exception 'Ticket is no longer serving' using errcode='23514'; end if;
  -- These rows also guard against simultaneous reactivation restoring a valid
  -- operational session while recovery checks it. Location is already locked.
  perform 1 from public.services where id=v_ticket.service_id for share nowait;
  if v_ticket.counter_id is not null then
    perform 1 from public.counters where id=v_ticket.counter_id for share nowait;
  end if;
  if exists(select 1 from private.live_counter_sessions live where live.id=v_ticket.counter_session_id) then
    raise exception 'Ticket has an active counter session' using errcode='23514';
  end if;
  -- Same terminal timestamp semantics as normal complete/skip. Only status and
  -- its timestamp change; keep all attribution, including null legacy counters.
  if p_action='skip' then
    update public.queue_tickets set status='SKIPPED',skipped_at=greatest(clock_timestamp(),started_at)
      where id=v_ticket.id and organization_id=v_location.organization_id and location_id=v_location.id and status='SERVING';
  else
    update public.queue_tickets set status='COMPLETED',completed_at=greatest(clock_timestamp(),started_at)
      where id=v_ticket.id and organization_id=v_location.organization_id and location_id=v_location.id and status='SERVING';
  end if;
  if not found then raise exception 'Ticket is no longer serving' using errcode='23514'; end if;
  -- No counter/session is started, ended, reassigned or deleted by this action.
  -- Existing queue triggers publish customer/staff/manager invalidations.
  return jsonb_build_object('id',v_ticket.id,'status',case when p_action='skip' then 'SKIPPED' else 'COMPLETED' end);
end;
$$;
revoke all on function public.resolve_stuck_serving_ticket(text,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.resolve_stuck_serving_ticket(text,uuid,uuid,text) to service_role;

create or replace function public.get_manager_counter_operations(p_token_hash text,p_location_id uuid,p_include_archived boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_l public.locations; v_now timestamptz:=statement_timestamp();
begin
  v_l:=private.require_manager_location(p_token_hash,p_location_id);
  return jsonb_build_object(
    'observedAt',v_now,'locationTimezone',v_l.timezone,
    'servingTickets',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'number',t.queue_number,
      'needsRecovery',not exists(select 1 from private.live_counter_sessions live where live.id=t.counter_session_id),
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



