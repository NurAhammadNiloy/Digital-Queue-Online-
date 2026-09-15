create or replace view private.live_counter_sessions as
select cs.* from public.counter_sessions cs
join public.counters c on c.id=cs.counter_id and c.active and c.archived_at is null
join public.staff st on st.id=cs.staff_id and st.active and st.archived_at is null
join public.services s on s.id=cs.service_id and s.active and s.archived_at is null
join public.locations l on l.id=cs.location_id and l.active and l.archived_at is null
join private.app_sessions a on a.token_hash=cs.auth_token_hash and a.staff_id=cs.staff_id
  and a.role='staff' and a.expires_at>now()
where cs.ended_at is null and exists(select 1 from public.staff_assignments sa
  where sa.staff_id=cs.staff_id and sa.organization_id=cs.organization_id
    and sa.location_id=cs.location_id and sa.service_id=cs.service_id);

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
      and not exists(select 1 from public.counter_sessions cs where cs.counter_id=c.id and cs.ended_at is null
        and (exists(select 1 from private.app_sessions a where a.token_hash=cs.auth_token_hash and a.expires_at>now())
          or exists(select 1 from public.queue_tickets t where t.counter_session_id=cs.id and t.status='SERVING')))), '[]'::jsonb)
  );
end;
$$;

drop function public.get_manager_counter_operations(text,uuid);
create function public.get_manager_counter_operations(p_token_hash text,p_location_id uuid,p_include_archived boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_l public.locations; v_now timestamptz:=statement_timestamp();
begin
  v_l:=private.require_manager_location(p_token_hash,p_location_id);
  return jsonb_build_object(
    'counters',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'active',c.active,'archived',c.archived_at is not null,
      'sessionId',cs.id,'staffName',st.name,'serviceName',s.name,
      'operational',exists(select 1 from private.live_counter_sessions live where live.id=cs.id),
      'ticketId',t.id,'ticketNumber',t.queue_number,'startedAt',cs.started_at) order by c.name,c.id)
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


revoke all on function public.get_staff_counter_state(text,uuid,uuid),public.get_manager_counter_operations(text,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.get_staff_counter_state(text,uuid,uuid),public.get_manager_counter_operations(text,uuid,boolean) to service_role;
