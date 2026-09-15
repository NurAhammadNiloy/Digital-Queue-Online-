-- Session cleanup may start with an auth-session row locked (pruning/login
-- rotation). Never invert the staff -> auth-session lock order used by actions.
-- If an action owns the staff lock, leave cleanup to lazy idle release instead;
-- ON DELETE SET NULL still invalidates the counter lease, preserving its ticket.
create or replace function private.close_revoked_idle_counters() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if old.staff_id is null then return old; end if;
  begin
    perform 1 from public.staff where id=old.staff_id for update nowait;
  exception when lock_not_available then return old;
  end;
  update public.counter_sessions cs set ended_at=greatest(clock_timestamp(),cs.started_at)
    where cs.auth_token_hash=old.token_hash and cs.ended_at is null
      and not exists(select 1 from public.queue_tickets t where t.counter_session_id=cs.id and t.status='SERVING');
  return old;
end;
$$;
revoke all on function private.close_revoked_idle_counters() from public,anon,authenticated,service_role;
