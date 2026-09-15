-- Private, data-free invalidations only. Queue rows, names and ticket tokens
-- are never published to browser-readable channels or replication tables.
create function private.broadcast_queue_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP <> 'DELETE' then
    perform realtime.send('{}'::jsonb,'queue_changed','queue:service:'||new.service_id,true);
    perform realtime.send('{}'::jsonb,'queue_changed','queue:location:'||new.location_id,true);
  end if;
  if TG_OP = 'DELETE' or (TG_OP = 'UPDATE' and (old.service_id,old.location_id) is distinct from (new.service_id,new.location_id)) then
    perform realtime.send('{}'::jsonb,'queue_changed','queue:service:'||old.service_id,true);
    perform realtime.send('{}'::jsonb,'queue_changed','queue:location:'||old.location_id,true);
  end if;
  return null;
exception when others then
  -- A notification outage must not roll back an otherwise valid queue action.
  -- Polling recovers state. Do not log row data or arbitrary exception messages.
  raise log 'Queue realtime notification unavailable: %', SQLSTATE;
  return null;
end;
$$;
revoke all on function private.broadcast_queue_change() from public,anon,authenticated,service_role;
create trigger queue_realtime_change after insert or update or delete on public.queue_tickets
for each row execute function private.broadcast_queue_change();

-- Defense in depth if other broadcast policies are introduced later. The
-- trusted Next.js subscriber uses service_role; browser roles cannot read or
-- forge notifications in this namespace. Existing unrelated policies survive.
create policy queue_signals_server_read on realtime.messages as restrictive
for select to anon,authenticated using (topic not like 'queue:%');
create policy queue_signals_server_write on realtime.messages as restrictive
for insert to anon,authenticated with check (topic not like 'queue:%');
