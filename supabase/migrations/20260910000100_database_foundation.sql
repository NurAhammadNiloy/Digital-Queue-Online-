-- Native PostgreSQL foundation. Apply using the Supabase migration owner.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  created_at timestamptz not null default now()
);

create table public.managers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id),
  name text not null check (length(btrim(name)) between 1 and 200),
  created_at timestamptz not null default now()
);
create index managers_organization_idx on public.managers (organization_id);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null check (length(btrim(name)) between 1 and 200),
  -- Global uniqueness is necessary because /q/[locationSlug] has no tenant ID.
  slug text not null unique check (
    length(slug) between 1 and 100 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  description text,
  address text,
  -- PostgreSQL validates the time-zone identifier, including DST rules.
  timezone text not null default 'UTC' check (
    length(timezone) between 1 and 100 and
    pg_catalog.timezone(timezone, timestamptz '2000-01-01 00:00:00+00') is not null
  ),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  location_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  queue_prefix text not null check (queue_prefix ~ '^[A-Z]{1,4}$'),
  default_service_minutes integer not null check (default_service_minutes > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  unique (organization_id, location_id, id),
  unique (location_id, queue_prefix)
);
create unique index services_location_name_key
  on public.services (location_id, lower(btrim(name)));

create table public.staff (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null check (length(btrim(name)) between 1 and 200),
  -- Staff ID + PIN has no tenant input, so the normalized login ID is global.
  staff_code text not null unique check (staff_code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  -- Hash-format guard only, not a hash verifier. Hash/verify on the server later.
  pin_hash text not null check (
    length(pin_hash) between 60 and 1024 and
    pin_hash ~ '^\$(argon2id|scrypt|2[aby])\$'
  ),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.staff_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  staff_id uuid not null,
  location_id uuid not null,
  service_id uuid not null,
  foreign key (organization_id, staff_id)
    references public.staff (organization_id, id) on delete cascade,
  foreign key (organization_id, location_id, service_id)
    references public.services (organization_id, location_id, id) on delete cascade,
  unique (staff_id, service_id)
);
create index staff_assignments_service_idx
  on public.staff_assignments (organization_id, location_id, service_id);
create index staff_assignments_staff_idx
  on public.staff_assignments (organization_id, staff_id);

-- One counter row per service/local calendar day. UPSERT serializes allocation.
create table public.service_daily_counters (
  organization_id uuid not null,
  location_id uuid not null,
  service_id uuid not null,
  queue_date date not null,
  last_number bigint not null check (last_number > 0),
  primary key (service_id, queue_date),
  foreign key (organization_id, location_id, service_id)
    references public.services (organization_id, location_id, id) on delete cascade
);
create index service_daily_counters_scope_idx
  on public.service_daily_counters (organization_id, location_id, service_id);

create table public.queue_tickets (
  id uuid primary key default gen_random_uuid(),
  -- Separate random UUID v4 bearer token: never use queue_number or id in URLs.
  ticket_token uuid not null unique default gen_random_uuid(),
  organization_id uuid not null,
  location_id uuid not null,
  service_id uuid not null,
  queue_date date not null,
  queue_sequence bigint not null check (queue_sequence > 0),
  queue_prefix text not null check (queue_prefix ~ '^[A-Z]{1,4}$'),
  queue_number text generated always as (
    queue_prefix || '-' || lpad(queue_sequence::text, greatest(3, length(queue_sequence::text)), '0')
  ) stored,
  customer_name text not null check (
    length(btrim(customer_name)) between 1 and 200 and customer_name ~ '[^[:space:]]'
  ),
  status text not null default 'WAITING'
    check (status in ('WAITING', 'SERVING', 'COMPLETED', 'SKIPPED')),
  joined_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  skipped_at timestamptz,
  served_by_staff_id uuid,
  foreign key (organization_id, location_id, service_id)
    references public.services (organization_id, location_id, id),
  foreign key (organization_id, served_by_staff_id)
    references public.staff (organization_id, id),
  unique (service_id, queue_date, queue_sequence),
  check (started_at >= joined_at),
  check (completed_at >= started_at),
  check (skipped_at >= started_at),
  constraint queue_tickets_state_check check (
    (status = 'WAITING' and started_at is null and served_by_staff_id is null
      and completed_at is null and skipped_at is null) or
    (status = 'SERVING' and started_at is not null and served_by_staff_id is not null
      and completed_at is null and skipped_at is null) or
    (status = 'COMPLETED' and started_at is not null and served_by_staff_id is not null
      and completed_at is not null and skipped_at is null) or
    (status = 'SKIPPED' and started_at is not null and served_by_staff_id is not null
      and completed_at is null and skipped_at is not null)
  )
);
create index queue_tickets_waiting_idx
  on public.queue_tickets (service_id, joined_at, id) where status = 'WAITING';
create unique index queue_tickets_one_serving_per_staff_key
  on public.queue_tickets (served_by_staff_id) where status = 'SERVING';
create index queue_tickets_organization_history_idx
  on public.queue_tickets (organization_id, joined_at desc);
create index queue_tickets_service_history_idx
  on public.queue_tickets (organization_id, location_id, service_id, completed_at desc)
  where status = 'COMPLETED';
create index queue_tickets_service_scope_idx
  on public.queue_tickets (organization_id, location_id, service_id);
create index queue_tickets_staff_idx
  on public.queue_tickets (organization_id, served_by_staff_id);

-- No caller-supplied tenant parameter; membership is provisioned only by a
-- trusted operator. Definer avoids recursive RLS when reading managers itself.
create function private.manager_organization_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select m.organization_id from public.managers m where m.user_id = (select auth.uid())
$$;
revoke all on function private.manager_organization_id() from public, anon, authenticated;
grant execute on function private.manager_organization_id() to authenticated;

alter table public.organizations enable row level security;
alter table public.managers enable row level security;
alter table public.locations enable row level security;
alter table public.services enable row level security;
alter table public.staff enable row level security;
alter table public.staff_assignments enable row level security;
alter table public.service_daily_counters enable row level security;
alter table public.queue_tickets enable row level security;

-- Remove inherited Supabase defaults; RLS and explicit grants work together.
revoke all on public.organizations, public.managers, public.locations,
  public.services, public.staff, public.staff_assignments,
  public.service_daily_counters, public.queue_tickets
  from public, anon, authenticated, service_role;

grant select on public.locations, public.services to anon;
grant select on public.organizations, public.managers, public.locations,
  public.services, public.staff_assignments, public.queue_tickets to authenticated;
grant insert, update, delete on public.locations, public.services,
  public.staff_assignments to authenticated;
-- Managers can read/edit metadata; PIN hashes never leave the trusted server.
grant select (id, organization_id, name, staff_code, active, created_at)
  on public.staff to authenticated;
grant update (name, staff_code, active), delete on public.staff to authenticated;

grant select, insert, update, delete on public.organizations, public.managers,
  public.locations, public.services, public.staff, public.staff_assignments to service_role;
grant select on public.queue_tickets to service_role;
-- Queue/counter mutations, including service_role calls, must go through RPCs.

create policy organizations_manager_read on public.organizations
  for select to authenticated
  using (id = (select private.manager_organization_id()));
create policy managers_organization_read on public.managers
  for select to authenticated
  using (organization_id = (select private.manager_organization_id()));
create policy locations_public_read on public.locations
  for select to anon using (active);
create policy services_public_read on public.services
  for select to anon using (
    active and exists (select 1 from public.locations l where l.id = location_id and l.active)
  );

create policy locations_manager_access on public.locations
  for all to authenticated
  using (organization_id = (select private.manager_organization_id()))
  with check (organization_id = (select private.manager_organization_id()));
create policy services_manager_access on public.services
  for all to authenticated
  using (organization_id = (select private.manager_organization_id()))
  with check (organization_id = (select private.manager_organization_id()));
create policy staff_manager_access on public.staff
  for all to authenticated
  using (organization_id = (select private.manager_organization_id()))
  with check (organization_id = (select private.manager_organization_id()));
create policy staff_assignments_manager_access on public.staff_assignments
  for all to authenticated
  using (organization_id = (select private.manager_organization_id()))
  with check (organization_id = (select private.manager_organization_id()));
create policy queue_tickets_manager_read on public.queue_tickets
  for select to authenticated
  using (organization_id = (select private.manager_organization_id()));
-- No client policy or table grant exists for the internal daily counters.
