-- Demo configuration only. Stable IDs make repeated local seeding harmless.
insert into public.organizations (id, name)
values ('10000000-0000-4000-8000-000000000001', 'Kokkola Health Services')
on conflict (id) do nothing;

insert into public.locations (id, organization_id, name, slug, timezone)
values (
  '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  'Kokkola Health Centre', 'kokkola-health-centre', 'Europe/Helsinki'
)
on conflict (id) do nothing;

insert into public.services
  (id, organization_id, location_id, name, queue_prefix, default_service_minutes)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000001', 'Doctor', 'D', 14),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000001', 'Nurse', 'N', 8),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000001', 'Reception', 'R', 4)
on conflict (id) do nothing;

-- No managers/Auth users, staff/PIN credentials, or customer tickets are seeded.
