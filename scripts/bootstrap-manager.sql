-- OPERATOR TEMPLATE. Not a migration or seed; never run automatically.
-- First create a confirmed email/password Auth user in the HOSTED project's
-- Authentication > Users. Keep its password out of SQL and source control.
-- Replace the non-secret placeholders below and review the selected project.
-- For an existing organization, set v_existing_org to its UUID; otherwise NULL.
-- The transaction refuses to move or overwrite an existing manager membership.
begin;
do $$
declare
  v_user uuid := 'REPLACE_WITH_CONFIRMED_AUTH_USER_UUID';
  v_existing_org uuid := null;
  v_org uuid;
  v_org_name text := 'REPLACE_WITH_ORGANIZATION_NAME';
  v_manager_name text := 'REPLACE_WITH_MANAGER_NAME';
begin
  if v_manager_name like 'REPLACE_WITH_%' or (v_existing_org is null and v_org_name like 'REPLACE_WITH_%') then
    raise exception 'Replace bootstrap placeholders before running.';
  end if;
  perform 1 from auth.users where id = v_user and email_confirmed_at is not null
    and encrypted_password <> '' and deleted_at is null
    and (banned_until is null or banned_until <= now()) for share;
  if not found then raise exception 'A confirmed, active password Auth user is required.'; end if;
  if exists (select 1 from public.managers where user_id = v_user) then
    raise exception 'User already has manager membership; bootstrap made no changes.';
  end if;
  if v_existing_org is null then
    insert into public.organizations(name) values (v_org_name) returning id into v_org;
  else
    select id into v_org from public.organizations where id = v_existing_org for share;
    if not found then raise exception 'Existing organization not found.'; end if;
  end if;
  insert into public.managers(user_id, organization_id, name) values (v_user, v_org, v_manager_name);
end;
$$;
commit;
