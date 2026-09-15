create table public.counters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  location_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 80 and name ~ '[^[:space:]]'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (organization_id,location_id) references public.locations(organization_id,id),
  unique (organization_id,location_id,id)
);
create unique index counters_location_name_key on public.counters(location_id,lower(btrim(name)));
create table public.counter_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  location_id uuid not null,
  service_id uuid not null,
  counter_id uuid not null,
  staff_id uuid not null,
  auth_token_hash text references private.app_sessions(token_hash) on delete set null,
  started_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz,
  foreign key (organization_id,location_id,counter_id) references public.counters(organization_id,location_id,id),
  foreign key (organization_id,location_id,service_id) references public.services(organization_id,location_id,id),
  foreign key (organization_id,staff_id) references public.staff(organization_id,id),
  check (ended_at >= started_at),
  unique (organization_id,location_id,service_id,staff_id,counter_id,id)
);
create unique index counter_sessions_one_counter on public.counter_sessions(counter_id) where ended_at is null;
create unique index counter_sessions_one_staff on public.counter_sessions(staff_id) where ended_at is null;
create index counter_sessions_location on public.counter_sessions(organization_id,location_id,service_id);
create index counter_sessions_auth on public.counter_sessions(auth_token_hash);
alter table public.queue_tickets add column counter_id uuid, add column counter_session_id uuid, add column counter_name text;
alter table public.queue_tickets add constraint ticket_counter_attribution check (
  (counter_id is null and counter_session_id is null and counter_name is null) or
  (counter_id is not null and counter_session_id is not null and counter_name is not null
    and served_by_staff_id is not null and status in ('SERVING','COMPLETED','SKIPPED'))
);
alter table public.queue_tickets add constraint ticket_counter_scope foreign key
  (organization_id,location_id,service_id,served_by_staff_id,counter_id,counter_session_id)
  references public.counter_sessions(organization_id,location_id,service_id,staff_id,counter_id,id);
create index queue_tickets_counter_session on public.queue_tickets(counter_session_id);
alter table public.counters enable row level security;
alter table public.counter_sessions enable row level security;
revoke all on public.counters,public.counter_sessions from public,anon,authenticated,service_role;
-- No direct browser access, including to counter-session credential digests.
grant select on public.counters,public.counter_sessions to service_role;

create view private.live_counter_sessions as
select cs.* from public.counter_sessions cs
join public.counters c on c.id=cs.counter_id and c.active
join public.staff st on st.id=cs.staff_id and st.active
join public.services s on s.id=cs.service_id and s.active
join public.locations l on l.id=cs.location_id and l.active
join private.app_sessions a on a.token_hash=cs.auth_token_hash and a.staff_id=cs.staff_id
  and a.role='staff' and a.expires_at>now()
where cs.ended_at is null and exists(select 1 from public.staff_assignments sa
  where sa.staff_id=cs.staff_id and sa.organization_id=cs.organization_id
    and sa.location_id=cs.location_id and sa.service_id=cs.service_id);
revoke all on private.live_counter_sessions from public,anon,authenticated,service_role;

create function private.counter_signal(p_location uuid) returns void
language plpgsql security definer set search_path='' as $$
declare v_service uuid;
begin
  perform realtime.send('{}'::jsonb,'queue_changed','queue:location:'||p_location,true);
  -- Counter availability affects staff selecting any permitted service here.
  for v_service in select id from public.services where location_id=p_location loop
    perform realtime.send('{}'::jsonb,'queue_changed','queue:service:'||v_service,true);
  end loop;
exception when others then raise log 'Counter notification unavailable: %', SQLSTATE;
end;
$$;
create function private.broadcast_counter_change() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if TG_OP<>'DELETE' then perform private.counter_signal(new.location_id); end if;
  if TG_OP='DELETE' then perform private.counter_signal(old.location_id); end if;
  if TG_OP='UPDATE' and old.location_id is distinct from new.location_id then perform private.counter_signal(old.location_id); end if;
  return null;
end;
$$;
create trigger counters_broadcast after insert or update or delete on public.counters for each row execute function private.broadcast_counter_change();
create trigger counter_sessions_broadcast after insert or update or delete on public.counter_sessions for each row execute function private.broadcast_counter_change();
create trigger counter_assignments_broadcast after insert or update or delete on public.staff_assignments for each row execute function private.broadcast_counter_change();

create function private.close_revoked_idle_counters() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update public.counter_sessions cs set ended_at=greatest(clock_timestamp(),cs.started_at)
    where cs.auth_token_hash=old.token_hash and cs.ended_at is null
      and not exists(select 1 from public.queue_tickets t where t.counter_session_id=cs.id and t.status='SERVING');
  return old;
end;
$$;
create trigger app_session_counter_release before delete on private.app_sessions for each row execute function private.close_revoked_idle_counters();

create function private.require_counter_staff(p_hash text) returns public.staff
language plpgsql security definer set search_path='' as $$
declare v_staff public.staff; v_id uuid;
begin
  select staff_id into v_id from private.app_sessions where token_hash=p_hash and role='staff';
  select * into v_staff from public.staff where id=v_id and active for update;
  if not found then raise exception 'Invalid staff session' using errcode='42501'; end if;
  perform 1 from private.app_sessions where token_hash=p_hash and staff_id=v_id and expires_at>now() for share;
  if not found or public.validate_app_session(p_hash) is null then raise exception 'Invalid staff session' using errcode='42501'; end if;
  return v_staff;
end;
$$;

create function public.manage_staff_counter(p_token_hash text,p_action text,p_location_id uuid default null,p_service_id uuid default null,p_counter_id uuid default null)
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
  -- Release only idle expired/revoked leases on this counter. Unique indexes
  -- remain the final concurrency guard. Live sessions require explicit release.
  update public.counter_sessions cs set ended_at=greatest(clock_timestamp(),cs.started_at)
    where cs.counter_id=p_counter_id and cs.ended_at is null
      and not exists(select 1 from private.app_sessions a where a.token_hash=cs.auth_token_hash and a.expires_at>now())
      and not exists(select 1 from public.queue_tickets t where t.counter_session_id=cs.id and t.status='SERVING');
  insert into public.counter_sessions(organization_id,location_id,service_id,counter_id,staff_id,auth_token_hash)
    values(v_staff.organization_id,p_location_id,p_service_id,p_counter_id,v_staff.id,p_token_hash) returning id into v_id;
  return v_id;
end;
$$;

create function public.manage_location_counter(p_token_hash text,p_location_id uuid,p_action text,p_counter_id uuid default null,p_name text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_l public.locations; v_staff uuid; v_cs public.counter_sessions; v_id uuid;
begin
  v_l:=private.require_manager_location(p_token_hash,p_location_id);
  if p_action is null or p_action not in ('create','rename','enable','disable','release') then raise exception 'Invalid action' using errcode='22023'; end if;
  if p_action in ('create','rename') and (p_name is null or length(btrim(p_name)) not between 1 and 80 or p_name !~ '[^[:space:]]') then raise exception 'Invalid counter name' using errcode='22023'; end if;
  if p_action='create' then
    if p_counter_id is not null then raise exception 'Invalid counter' using errcode='22023'; end if;
    insert into public.counters(organization_id,location_id,name) values(v_l.organization_id,v_l.id,btrim(p_name)) returning id into v_id;
    return v_id;
  end if;
  -- Match staff -> counter lock order used by staff actions. Recheck the
  -- occupant after locking; a changed occupant yields a retryable conflict.
  if p_action='release' then
    select staff_id into v_staff from public.counter_sessions where counter_id=p_counter_id and location_id=v_l.id and organization_id=v_l.organization_id and ended_at is null;
    if v_staff is not null then perform 1 from public.staff where id=v_staff for update; end if;
  end if;
  perform 1 from public.counters where id=p_counter_id and organization_id=v_l.organization_id and location_id=v_l.id for update;
  if not found then raise exception 'Counter not found' using errcode='P0002'; end if;
  select * into v_cs from public.counter_sessions where counter_id=p_counter_id and ended_at is null;
  if p_action='release' then
    if v_cs.id is null then return p_counter_id; end if;
    if v_cs.staff_id is distinct from v_staff then raise exception 'Counter occupant changed; retry' using errcode='23514'; end if;
    if exists(select 1 from public.queue_tickets where counter_session_id=v_cs.id and status='SERVING') then
      raise exception 'Complete or skip the current ticket before releasing this counter' using errcode='23514';
    end if;
    update public.counter_sessions set ended_at=greatest(clock_timestamp(),started_at) where id=v_cs.id;
  elsif p_action='disable' then
    if v_cs.id is not null then raise exception 'Release the occupied counter first' using errcode='23514'; end if;
    update public.counters set active=false where id=p_counter_id;
  elsif p_action='enable' then update public.counters set active=true where id=p_counter_id;
  else update public.counters set name=btrim(p_name) where id=p_counter_id;
  end if;
  return p_counter_id;
end;
$$;

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

-- Logout releases idle counters atomically with authentication revocation.
-- A serving ticket is preserved; another login can finish it before ending.
create or replace function public.revoke_app_session(p_token_hash text) returns void
language plpgsql security definer set search_path='' as $$
declare v_staff uuid;
begin
  select staff_id into v_staff from private.app_sessions where token_hash=p_token_hash;
  if v_staff is not null then
    perform 1 from public.staff where id=v_staff for update;
    update public.counter_sessions cs set ended_at=greatest(clock_timestamp(),cs.started_at)
      where cs.staff_id=v_staff and cs.ended_at is null
        and not exists(select 1 from public.queue_tickets t where t.served_by_staff_id=v_staff and t.status='SERVING');
  end if;
  delete from private.app_sessions where token_hash=p_token_hash;
end;
$$;

revoke all on function private.counter_signal(uuid),private.broadcast_counter_change(),private.close_revoked_idle_counters(),private.require_counter_staff(text) from public,anon,authenticated,service_role;
revoke all on function public.manage_staff_counter(text,text,uuid,uuid,uuid),public.manage_location_counter(text,uuid,text,uuid,text),public.perform_staff_queue_action(text,text,uuid,uuid),public.revoke_app_session(text) from public,anon,authenticated,service_role;
grant execute on function public.manage_staff_counter(text,text,uuid,uuid,uuid),public.manage_location_counter(text,uuid,text,uuid,text),public.perform_staff_queue_action(text,text,uuid,uuid),public.revoke_app_session(text) to service_role;
