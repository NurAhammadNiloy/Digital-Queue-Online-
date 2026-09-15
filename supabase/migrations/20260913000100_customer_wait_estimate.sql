-- Derived estimates only. Queue ordering, mutations, authentication and RLS
-- remain unchanged. Existing history/waiting indexes support these reads.
create function private.queue_wait_minutes(
  p_organization_id uuid, p_location_id uuid, p_service_id uuid, p_people_ahead bigint
)
returns numeric language sql stable security definer set search_path = ''
as $$
  select case when p_people_ahead >= 0 then
    ceil(p_people_ahead::numeric * coalesce(
      (select case when count(*) >= 5 then avg(sample.seconds) end from (
        select extract(epoch from (t.completed_at - t.started_at)) as seconds
        from public.queue_tickets t
        where t.organization_id = s.organization_id and t.location_id = s.location_id
          and t.service_id = s.id and t.status = 'COMPLETED'
          and isfinite(t.started_at) and isfinite(t.completed_at)
          and t.completed_at > t.started_at
          and t.completed_at >= now() - interval '30 days' and t.completed_at <= now()
        order by t.completed_at desc, t.id desc limit 100
      ) sample),
      case when s.default_service_minutes > 0 then s.default_service_minutes::numeric * 60 end
    ) / 60)
  end
  from public.services s where s.id = p_service_id
    and s.organization_id = p_organization_id and s.location_id = p_location_id
$$;

create or replace function public.get_public_queue_location(p_slug text)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'name', l.name, 'organizationName', o.name, 'slug', l.slug,
    'services', coalesce((select jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'code', s.queue_prefix, 'waitingCount', waiting.n,
      'estimatedWaitMinutes', private.queue_wait_minutes(l.organization_id,l.id,s.id,waiting.n)
    ) order by s.name,s.id) from public.services s
      cross join lateral (select count(*) as n from public.queue_tickets t
        where t.organization_id = l.organization_id and t.location_id = l.id
          and t.service_id = s.id and t.status = 'WAITING') waiting
      where s.location_id = l.id and s.organization_id = l.organization_id and s.active), '[]'::jsonb)
  ) from public.locations l join public.organizations o on o.id = l.organization_id
    where l.slug = p_slug and l.active
$$;

create or replace function public.get_public_queue_ticket(p_token uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  -- Status, people ahead and duration history share the same database snapshot.
  with view as materialized (
    select safe.queue_number, s.name as service, l.name as location, safe.status,
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
    'status', v.status, 'joinedAt', v.joined_at, 'calledAt', v.started_at,
    'completedAt', v.completed_at, 'skippedAt', v.skipped_at, 'peopleAhead', v.people_ahead,
    'estimatedWaitMinutes', case when v.status = 'WAITING' then
      private.queue_wait_minutes(v.organization_id,v.location_id,v.service_id,v.people_ahead) end
  ) from view v
$$;

revoke all on function private.queue_wait_minutes(uuid,uuid,uuid,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.get_public_queue_location(text), public.get_public_queue_ticket(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_public_queue_location(text), public.get_public_queue_ticket(uuid)
  to service_role;
