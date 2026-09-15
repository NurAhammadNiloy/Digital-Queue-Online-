-- Only new automatic IDs change. Existing IDs and the global unique index
-- remain intact: Staff ID + PIN login has no organization discriminator.
-- Gaps are expected after collisions or rolled-back creations; never cycle.
create sequence private.staff_code_sequence as bigint start with 1000 no cycle;
revoke all on sequence private.staff_code_sequence from public, anon, authenticated, service_role;

create or replace function public.manage_staff(
  p_token_hash text, p_operation text, p_staff_id uuid default null,
  p_name text default null, p_staff_code text default null,
  p_pin_hash text default null, p_assignments jsonb default null,
  p_active boolean default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_manager_id uuid;
  v_org uuid;
  v_staff_id uuid;
  v_count integer;
  v_auto_code boolean := p_operation = 'create' and nullif(btrim(p_staff_code), '') is null;
begin
  select manager_user_id into v_manager_id from private.app_sessions
  where token_hash = p_token_hash and role = 'manager';
  -- Match credential/membership revocation lock order: identity before session.
  select m.organization_id into v_org
  from public.managers m join auth.users u on u.id = m.user_id
  where m.user_id = v_manager_id for share of m, u;
  if not found then
    raise exception 'Manager authentication required' using errcode = '42501';
  end if;
  perform 1 from private.app_sessions where token_hash = p_token_hash
    and role = 'manager' and expires_at > now() for share;
  if not found or public.validate_app_session(p_token_hash) is null then
    raise exception 'Manager authentication required' using errcode = '42501';
  end if;

  if p_operation is null or p_operation not in ('create', 'update', 'reset-pin', 'set-active') then
    raise exception 'Invalid staff operation' using errcode = '22023';
  end if;
  if p_operation = 'create' then
    if p_staff_id is not null or p_active is not null then
      raise exception 'Invalid creation parameters' using errcode = '22023';
    end if;
  else
    -- Same staff-row lock used by queue actions and credential verification.
    select id into v_staff_id from public.staff
    where id = p_staff_id and organization_id = v_org for update;
    if not found then
      raise exception 'Staff member not found' using errcode = 'P0002';
    end if;
  end if;

  if p_operation in ('create', 'update') then
    if p_name is null or length(btrim(p_name)) not between 1 and 200 or p_name !~ '[^[:space:]]'
      or (not v_auto_code and (p_staff_code is null or upper(btrim(p_staff_code)) !~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'))
      or p_active is not null then
      raise exception 'Invalid staff details' using errcode = '22023';
    end if;
    if p_assignments is null or jsonb_typeof(p_assignments) <> 'array' then
      raise exception 'Assignments must be an array' using errcode = '22023';
    end if;
    if jsonb_array_length(p_assignments) > 25 then
      raise exception 'Too many assignments' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_assignments) a
      where jsonb_typeof(a) <> 'object' or not (a ?& array['locationId','serviceId'])
        or a - 'locationId' - 'serviceId' <> '{}'::jsonb
        or jsonb_typeof(a->'locationId') <> 'string' or jsonb_typeof(a->'serviceId') <> 'string') then
      raise exception 'Invalid assignments' using errcode = '22023';
    end if;
    select count(distinct a."serviceId") into v_count
      from jsonb_to_recordset(p_assignments) a("locationId" uuid, "serviceId" uuid);
    if v_count <> jsonb_array_length(p_assignments) then
      raise exception 'Duplicate service assignments' using errcode = '22023';
    end if;
    perform s.id from public.services s
      join public.locations l on l.id = s.location_id and l.organization_id = s.organization_id
      join jsonb_to_recordset(p_assignments) a("locationId" uuid, "serviceId" uuid)
        on a."serviceId" = s.id and a."locationId" = l.id
      where s.organization_id = v_org
      order by s.id for share of s, l;
    get diagnostics v_count = row_count;
    if v_count <> jsonb_array_length(p_assignments) then
      raise exception 'Location/service assignment is not permitted' using errcode = '42501';
    end if;
  else
    if p_name is not null or p_staff_code is not null or p_assignments is not null then
      raise exception 'Unexpected staff fields' using errcode = '22023';
    end if;
  end if;

  if p_operation in ('create', 'reset-pin') then
    -- The application hashes the PIN. Never accept plaintext or weaker formats.
    if p_pin_hash is null or p_pin_hash !~ '^\$scrypt\$ln=17,r=8,p=1\$[a-f0-9]{32}\$[a-f0-9]{128}$'
      or p_active is not null then
      raise exception 'Invalid credential format' using errcode = '22023';
    end if;
  elsif p_pin_hash is not null then
    raise exception 'Unexpected credential' using errcode = '22023';
  end if;

  if p_operation = 'create' then
    if v_auto_code then
      loop
        -- nextval is concurrency-safe. The existing unique index arbitrates
        -- races with custom codes, including codes in other organizations.
        insert into public.staff(organization_id, name, staff_code, pin_hash)
          values (v_org, btrim(p_name), 'S' || nextval('private.staff_code_sequence'::regclass)::text, p_pin_hash)
          on conflict (staff_code) do nothing
          returning id into v_staff_id;
        exit when v_staff_id is not null;
      end loop;
    else
      insert into public.staff(organization_id, name, staff_code, pin_hash)
        values (v_org, btrim(p_name), upper(btrim(p_staff_code)), p_pin_hash)
        returning id into v_staff_id;
    end if;
  elsif p_operation = 'update' then
    update public.staff set name = btrim(p_name), staff_code = upper(btrim(p_staff_code))
      where id = v_staff_id;
  elsif p_operation = 'reset-pin' then
    update public.staff set pin_hash = p_pin_hash where id = v_staff_id;
    -- Also handles any trusted caller supplying the already-stored hash.
    delete from private.app_sessions where staff_id = v_staff_id;
  else
    if p_active is null then
      raise exception 'Account status is required' using errcode = '22023';
    end if;
    update public.staff set active = p_active where id = v_staff_id;
    if not p_active then
      delete from private.app_sessions where staff_id = v_staff_id;
    end if;
  end if;

  if p_operation in ('create', 'update') then
    -- Full replacement semantics, while retaining IDs of unchanged assignments.
    delete from public.staff_assignments sa where sa.staff_id = v_staff_id
      and not exists (select 1 from jsonb_to_recordset(p_assignments) a("locationId" uuid, "serviceId" uuid)
        where a."serviceId" = sa.service_id and a."locationId" = sa.location_id);
    insert into public.staff_assignments(organization_id, staff_id, location_id, service_id)
      select v_org, v_staff_id, a."locationId", a."serviceId"
      from jsonb_to_recordset(p_assignments) a("locationId" uuid, "serviceId" uuid)
      on conflict (staff_id, service_id) do nothing;
  end if;
  -- Return only the identifier, never the staff row containing pin_hash.
  return v_staff_id;
end;
$$;
revoke all on function public.manage_staff(text,text,uuid,text,text,text,jsonb,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.manage_staff(text,text,uuid,text,text,text,jsonb,boolean) to service_role;
