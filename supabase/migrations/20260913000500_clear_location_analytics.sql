-- Password reauthentication happens in the trusted Next.js route. This RPC
-- independently binds the verified Auth identity, current session and location.
create function public.clear_manager_location_history(
  p_token_hash text, p_location_id uuid, p_verified_user_id uuid
)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_location public.locations; v_deleted bigint;
begin
  -- Locks manager/Auth identity before session, preserving revocation ordering.
  v_location := private.require_manager_location(p_token_hash,p_location_id);
  if p_verified_user_id is null or not exists (
    select 1 from private.app_sessions where token_hash=p_token_hash
      and role='manager' and manager_user_id=p_verified_user_id
      and organization_id=v_location.organization_id and expires_at>now()
  ) then
    raise exception 'Manager authentication required' using errcode='42501';
  end if;

  delete from public.queue_tickets
    where organization_id=v_location.organization_id and location_id=v_location.id
      and status='COMPLETED';
  get diagnostics v_deleted = row_count;
  -- The existing customer_join_requests FK removes only dependencies of the
  -- deleted tickets, atomically. WAITING/SERVING/SKIPPED and configuration stay.
  -- Never delete/update service_daily_counters: history removal must not reuse
  -- numbers. create_queue_ticket already allocates 001 for a new local date.
  return v_deleted;
end;
$$;
revoke all on function public.clear_manager_location_history(text,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.clear_manager_location_history(text,uuid,uuid) to service_role;
