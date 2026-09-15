-- Only opaque-token digests are persisted. These tables are not API-exposed.
create table private.app_sessions (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  role text not null check (role in ('staff', 'manager')),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  staff_id uuid references public.staff(id) on delete cascade,
  manager_user_id uuid references public.managers(user_id) on delete cascade,
  credential_version text not null check (credential_version ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  check (expires_at > created_at and expires_at <= created_at + interval '8 hours'),
  check ((role = 'staff' and staff_id is not null and manager_user_id is null)
    or (role = 'manager' and manager_user_id is not null and staff_id is null))
);
create index app_sessions_expiry_idx on private.app_sessions(expires_at);
create index app_sessions_staff_idx on private.app_sessions(staff_id);
create index app_sessions_manager_idx on private.app_sessions(manager_user_id);

create table private.auth_rate_limits (
  key_hash text primary key check (key_hash ~ '^[a-f0-9]{64}$'),
  attempts integer not null check (attempts > 0),
  resets_at timestamptz not null
);
create index auth_rate_limits_expiry_idx on private.auth_rate_limits(resets_at);
alter table private.app_sessions enable row level security;
alter table private.auth_rate_limits enable row level security;
revoke all on private.app_sessions, private.auth_rate_limits from public, anon, authenticated, service_role;

-- Used before Supabase Auth password verification, so a password change racing
-- with verification cannot produce a session for a different credential version.
create function public.get_manager_login_context(p_email text)
returns table (user_id uuid, credential_version text)
language sql stable security definer set search_path = ''
as $$
  select u.id, encode(sha256(convert_to(u.encrypted_password, 'UTF8')), 'hex')
  from auth.users u join public.managers m on m.user_id = u.id
  where lower(u.email) = lower(p_email) and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= now())
$$;

create function public.issue_app_session(
  p_token_hash text, p_role text, p_identity_id uuid,
  p_credential_version text, p_previous_token_hash text default null
)
returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_created timestamptz := clock_timestamp();
begin
  if p_role = 'staff' then
    select s.organization_id into v_org from public.staff s
    where s.id = p_identity_id and s.active
      and encode(sha256(convert_to(s.pin_hash, 'UTF8')), 'hex') = p_credential_version
    for share;
  elsif p_role = 'manager' then
    select m.organization_id into v_org
    from public.managers m join auth.users u on u.id = m.user_id
    where m.user_id = p_identity_id and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= now())
      and encode(sha256(convert_to(u.encrypted_password, 'UTF8')), 'hex') = p_credential_version
    for share of m, u;
  end if;
  if v_org is null then
    raise exception 'Invalid authentication context' using errcode = '42501';
  end if;
  delete from private.app_sessions where token_hash = p_previous_token_hash;
  insert into private.app_sessions
    (token_hash, role, organization_id, staff_id, manager_user_id, credential_version, created_at, expires_at)
  values (p_token_hash, p_role, v_org,
    case when p_role = 'staff' then p_identity_id end,
    case when p_role = 'manager' then p_identity_id end,
    p_credential_version, v_created, v_created + interval '8 hours');
  return v_created + interval '8 hours';
end;
$$;

create function public.validate_app_session(p_token_hash text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when a.role = 'staff' then jsonb_build_object(
    'role', 'staff', 'id', s.id, 'organizationId', a.organization_id,
    'name', s.name, 'expiresAt', a.expires_at,
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object('locationId', sa.location_id, 'serviceId', sa.service_id))
      from public.staff_assignments sa
      join public.services sv on sv.id = sa.service_id and sv.active
      join public.locations l on l.id = sa.location_id and l.active
      where sa.staff_id = s.id and sa.organization_id = a.organization_id
    ), '[]'::jsonb)
  ) else jsonb_build_object(
    'role', 'manager', 'id', m.user_id, 'organizationId', a.organization_id,
    'name', m.name, 'expiresAt', a.expires_at
  ) end
  from private.app_sessions a
  left join public.staff s on s.id = a.staff_id and s.organization_id = a.organization_id
  left join public.managers m on m.user_id = a.manager_user_id and m.organization_id = a.organization_id
  left join auth.users u on u.id = m.user_id
  where a.token_hash = p_token_hash and a.expires_at > now()
    and ((a.role = 'staff' and s.active
      and a.credential_version = encode(sha256(convert_to(s.pin_hash, 'UTF8')), 'hex'))
    or (a.role = 'manager' and u.deleted_at is null and u.id is not null
      and (u.banned_until is null or u.banned_until <= now())
      and a.credential_version = encode(sha256(convert_to(u.encrypted_password, 'UTF8')), 'hex')))
$$;

create function public.revoke_app_session(p_token_hash text)
returns void language sql security definer set search_path = ''
as $$ delete from private.app_sessions where token_hash = p_token_hash $$;

-- Fixed-window throttling shared by every server instance. Consume before KDF.
create function public.consume_auth_attempt(p_key_hash text, p_limit integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare v_attempts integer;
begin
  if p_limit not between 1 and 1000 or p_window_seconds not between 1 and 3600 then
    raise exception 'Invalid rate limit' using errcode = '22023';
  end if;
  insert into private.auth_rate_limits as limits(key_hash, attempts, resets_at)
  values (p_key_hash, 1, clock_timestamp() + make_interval(secs => p_window_seconds))
  on conflict (key_hash) do update set
    attempts = case when limits.resets_at <= clock_timestamp() then 1 else least(limits.attempts + 1, p_limit + 1) end,
    resets_at = case when limits.resets_at <= clock_timestamp()
      then clock_timestamp() + make_interval(secs => p_window_seconds) else limits.resets_at end
  returning attempts into v_attempts;
  return v_attempts <= p_limit;
end;
$$;

-- Invoke periodically from a trusted maintenance task; never from browser code.
create function public.prune_auth_state()
returns void language sql security definer set search_path = ''
as $$
  delete from private.app_sessions where expires_at <= now();
  delete from private.auth_rate_limits where resets_at < now() - interval '1 day';
$$;

revoke all on function public.get_manager_login_context(text),
  public.issue_app_session(text,text,uuid,text,text), public.validate_app_session(text),
  public.revoke_app_session(text), public.consume_auth_attempt(text,integer,integer),
  public.prune_auth_state() from public, anon, authenticated, service_role;
grant execute on function public.get_manager_login_context(text),
  public.issue_app_session(text,text,uuid,text,text), public.validate_app_session(text),
  public.revoke_app_session(text), public.consume_auth_attempt(text,integer,integer),
  public.prune_auth_state() to service_role;

-- Revocation is permanent, including deactivate/reactivate and ban/unban cycles.
create function private.revoke_changed_staff_sessions()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  delete from private.app_sessions where staff_id = old.id;
  return new;
end;
$$;
create trigger staff_credentials_revoke_sessions
after update of pin_hash, active, organization_id on public.staff
for each row when (old.pin_hash is distinct from new.pin_hash or old.active is distinct from new.active
  or old.organization_id is distinct from new.organization_id)
execute function private.revoke_changed_staff_sessions();

create function private.revoke_changed_manager_sessions()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  delete from private.app_sessions where manager_user_id = old.user_id;
  return new;
end;
$$;
create trigger manager_membership_revoke_sessions
after update of organization_id on public.managers
for each row when (old.organization_id is distinct from new.organization_id)
execute function private.revoke_changed_manager_sessions();

create function private.revoke_changed_auth_user_sessions()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  delete from private.app_sessions where manager_user_id = old.id;
  return new;
end;
$$;
create trigger queue_manager_credentials_revoke_sessions
after update of encrypted_password, banned_until, deleted_at on auth.users
for each row when (old.encrypted_password is distinct from new.encrypted_password
  or old.banned_until is distinct from new.banned_until or old.deleted_at is distinct from new.deleted_at)
execute function private.revoke_changed_auth_user_sessions();
revoke all on function private.revoke_changed_staff_sessions(),
  private.revoke_changed_manager_sessions(), private.revoke_changed_auth_user_sessions()
  from public, anon, authenticated, service_role;
