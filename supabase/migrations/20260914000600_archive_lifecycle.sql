alter table public.staff add column archived_at timestamptz, add constraint staff_archive_inactive check (archived_at is null or not active);
alter table public.services add column archived_at timestamptz, add constraint services_archive_inactive check (archived_at is null or not active);
alter table public.counters add column archived_at timestamptz, add constraint counters_archive_inactive check (archived_at is null or not active);
alter table public.locations add column archived_at timestamptz, add constraint locations_archive_inactive check (archived_at is null or not active);

-- All application writes already use manager-session RPCs. Remove legacy
-- direct browser writes so archive orchestration cannot be bypassed via REST.
revoke insert,update,delete on public.locations,public.services,public.staff_assignments from authenticated;
revoke update(name,staff_code,active),delete on public.staff from authenticated;
grant select(archived_at) on public.staff to authenticated;

create function private.guard_archived_entity() returns trigger
language plpgsql set search_path='' as $$
declare v_lifecycle boolean:=coalesce(current_setting('queue.lifecycle',true),'')='1'; v_archived timestamptz;
begin
  if TG_OP='INSERT' then
    if new.archived_at is not null and not v_lifecycle then raise exception 'Use manager lifecycle action' using errcode='42501'; end if;
  else
    if old.archived_at is distinct from new.archived_at and not v_lifecycle then raise exception 'Use manager lifecycle action' using errcode='42501'; end if;
    if old.archived_at is not null and new.archived_at is not null and new is distinct from old then
      raise exception 'Restore archived entity before editing' using errcode='23514';
    end if;
  end if;
  if TG_TABLE_NAME in ('services','counters') and new.archived_at is null then
    select archived_at into v_archived from public.locations where id=new.location_id for share nowait;
    if v_archived is not null then raise exception 'Restore parent location first' using errcode='23514'; end if;
  end if;
  return new;
end;
$$;
create trigger staff_archive_guard before insert or update on public.staff for each row execute function private.guard_archived_entity();
create trigger services_archive_guard before insert or update on public.services for each row execute function private.guard_archived_entity();
create trigger counters_archive_guard before insert or update on public.counters for each row execute function private.guard_archived_entity();
create trigger locations_archive_guard before insert or update on public.locations for each row execute function private.guard_archived_entity();

create function private.guard_archived_assignment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.staff where id=new.staff_id and archived_at is null for share;
  if not found then raise exception 'Archived staff cannot receive permissions' using errcode='42501'; end if;
  perform 1 from public.services s join public.locations l on l.id=s.location_id
    where s.id=new.service_id and s.location_id=new.location_id and s.archived_at is null and l.archived_at is null for share of s,l;
  if not found then raise exception 'Archived assignment is unavailable' using errcode='42501'; end if;
  return new;
end;
$$;
create trigger assignments_archive_guard before insert or update on public.staff_assignments for each row execute function private.guard_archived_assignment();

create function private.lifecycle_table(p_kind text) returns text
language plpgsql immutable set search_path='' as $$
begin
  if p_kind is null or p_kind not in ('staff','services','counters','locations') then raise exception 'Invalid entity' using errcode='22023'; end if;
  return p_kind;
end;
$$;
create function private.entity_has_dependencies(p_kind text,p_id uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
  if p_kind='staff' then return
    exists(select 1 from public.queue_tickets where served_by_staff_id=p_id) or
    exists(select 1 from public.counter_sessions where staff_id=p_id) or
    exists(select 1 from public.staff_assignments where staff_id=p_id) or
    exists(select 1 from private.app_sessions where staff_id=p_id);
  elsif p_kind='services' then return
    exists(select 1 from public.queue_tickets where service_id=p_id) or
    exists(select 1 from public.counter_sessions where service_id=p_id) or
    exists(select 1 from public.staff_assignments where service_id=p_id) or
    exists(select 1 from public.service_daily_counters where service_id=p_id);
  elsif p_kind='counters' then return exists(select 1 from public.counter_sessions where counter_id=p_id) or exists(select 1 from public.queue_tickets where counter_id=p_id);
  elsif p_kind='locations' then return
    exists(select 1 from public.services where location_id=p_id) or exists(select 1 from public.counters where location_id=p_id) or
    exists(select 1 from public.queue_tickets where location_id=p_id) or exists(select 1 from public.counter_sessions where location_id=p_id) or
    exists(select 1 from public.staff_assignments where location_id=p_id) or exists(select 1 from public.service_daily_counters where location_id=p_id);
  end if;
  raise exception 'Invalid entity' using errcode='22023';
end;
$$;
create function private.entity_has_live_work(p_kind text,p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.queue_tickets t where
    (p_kind='staff' and t.served_by_staff_id=p_id and t.status='SERVING') or
    (p_kind='counters' and t.counter_id=p_id and t.status='SERVING') or
    (p_kind='services' and t.service_id=p_id and t.status in ('WAITING','SERVING')) or
    (p_kind='locations' and t.location_id=p_id and t.status in ('WAITING','SERVING')))
    or exists(select 1 from public.counter_sessions cs where cs.ended_at is null and
      ((p_kind='services' and cs.service_id=p_id) or (p_kind='locations' and cs.location_id=p_id)))
$$;

create function public.preview_manager_lifecycle(p_token_hash text,p_kind text,p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_org uuid; v_entity jsonb;
begin
  v_org:=private.require_manager_organization(p_token_hash);
  execute format('select jsonb_build_object(''id'',id,''name'',name,''archived'',archived_at is not null) from public.%I where id=$1 and organization_id=$2',private.lifecycle_table(p_kind)) into v_entity using p_id,v_org;
  if v_entity is null then raise exception 'Entity not found' using errcode='P0002'; end if;
  return v_entity||jsonb_build_object('action',case when private.entity_has_dependencies(p_kind,p_id) then 'archive' else 'permanent-delete' end,
    'blocked',private.entity_has_live_work(p_kind,p_id));
end;
$$;

create function public.manage_entity_lifecycle(p_token_hash text,p_kind text,p_id uuid,p_action text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_org uuid; v_table text; v_archived timestamptz; v_name text; v_dependencies boolean;
begin
  v_org:=private.require_manager_organization(p_token_hash); v_table:=private.lifecycle_table(p_kind);
  if p_action is null or p_action not in ('archive','permanent-delete','restore') then raise exception 'Invalid lifecycle action' using errcode='22023'; end if;
  -- Rare manager lifecycle changes serialize with staff actions. NOWAIT avoids
  -- lock-order inversions with existing configuration/queue RPCs: retry safely.
  perform id from public.staff where organization_id=v_org order by id for update nowait;
  execute format('select name,archived_at from public.%I where id=$1 and organization_id=$2 for update nowait',v_table) into v_name,v_archived using p_id,v_org;
  if v_name is null then raise exception 'Entity not found' using errcode='P0002'; end if;
  if p_kind='locations' then
    perform id from public.services where location_id=p_id order by id for update nowait;
    perform id from public.counters where location_id=p_id order by id for update nowait;
  end if;
  if private.entity_has_live_work(p_kind,p_id) then raise exception 'Resolve waiting/serving tickets and active counter sessions first' using errcode='23514'; end if;
  v_dependencies:=private.entity_has_dependencies(p_kind,p_id);
  if p_action='permanent-delete' then
    if v_dependencies then raise exception 'Dependencies changed; review Delete again to archive instead' using errcode='23503'; end if;
    execute format('delete from public.%I where id=$1 and organization_id=$2',v_table) using p_id,v_org;
    return jsonb_build_object('outcome','deleted');
  end if;
  perform set_config('queue.lifecycle','1',true);
  if p_action='restore' then
    if v_archived is null then raise exception 'Entity is not archived' using errcode='23514'; end if;
    -- Never resurrect permissions or counter/auth sessions on restore.
    if p_kind='staff' then
      delete from public.staff_assignments where staff_id=p_id;
      delete from private.app_sessions where staff_id=p_id;
    end if;
    execute format('update public.%I set archived_at=null,active=false where id=$1 and organization_id=$2',v_table) using p_id,v_org;
    return jsonb_build_object('outcome','restored');
  end if;
  if v_archived is not null then return jsonb_build_object('outcome','archived'); end if;
  if p_kind in ('staff','counters') then
    update public.counter_sessions set ended_at=greatest(clock_timestamp(),started_at) where ended_at is null and
      ((p_kind='staff' and staff_id=p_id) or (p_kind='counters' and counter_id=p_id));
  end if;
  if p_kind='staff' then
    delete from private.app_sessions where staff_id=p_id;
    delete from public.staff_assignments where staff_id=p_id;
  elsif p_kind='services' then delete from public.staff_assignments where service_id=p_id;
  elsif p_kind='locations' then
    delete from public.staff_assignments where location_id=p_id;
    update public.services set archived_at=clock_timestamp(),active=false where location_id=p_id and archived_at is null;
    update public.counters set archived_at=clock_timestamp(),active=false where location_id=p_id and archived_at is null;
  end if;
  execute format('update public.%I set archived_at=clock_timestamp(),active=false where id=$1 and organization_id=$2',v_table) using p_id,v_org;
  return jsonb_build_object('outcome','archived');
end;
$$;

create function public.skip_release_counter(p_token_hash text,p_location_id uuid,p_counter_id uuid,p_session_id uuid,p_ticket_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_l public.locations; v_staff uuid; v_cs public.counter_sessions;
begin
  v_l:=private.require_manager_location(p_token_hash,p_location_id);
  select staff_id into v_staff from public.counter_sessions where id=p_session_id and counter_id=p_counter_id
    and location_id=v_l.id and organization_id=v_l.organization_id and ended_at is null;
  if not found then raise exception 'Counter session changed; refresh and confirm again' using errcode='23514'; end if;
  perform 1 from public.staff where id=v_staff for update;
  perform 1 from public.counters where id=p_counter_id and location_id=v_l.id and organization_id=v_l.organization_id for update;
  select * into v_cs from public.counter_sessions where id=p_session_id and counter_id=p_counter_id and ended_at is null;
  if not found then raise exception 'Counter session changed; refresh and confirm again' using errcode='23514'; end if;
  update public.queue_tickets set status='SKIPPED',skipped_at=greatest(clock_timestamp(),started_at)
    where id=p_ticket_id and counter_session_id=v_cs.id and counter_id=p_counter_id
      and organization_id=v_l.organization_id and location_id=v_l.id and status='SERVING';
  if not found then raise exception 'Serving ticket changed; refresh and confirm again' using errcode='23514'; end if;
  update public.counter_sessions set ended_at=greatest(clock_timestamp(),started_at) where id=v_cs.id;
  return p_counter_id;
end;
$$;

revoke all on function private.guard_archived_entity(),private.guard_archived_assignment(),private.lifecycle_table(text),private.entity_has_dependencies(text,uuid),private.entity_has_live_work(text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.preview_manager_lifecycle(text,text,uuid),public.manage_entity_lifecycle(text,text,uuid,text),public.skip_release_counter(text,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.preview_manager_lifecycle(text,text,uuid),public.manage_entity_lifecycle(text,text,uuid,text),public.skip_release_counter(text,uuid,uuid,uuid,uuid) to service_role;
