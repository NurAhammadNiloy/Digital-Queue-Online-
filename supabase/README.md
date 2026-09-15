# Database foundation

Requires Docker and Supabase CLI (validated with **2.117.0**, PostgreSQL **17.6**). Use Node.js 24 for the existing application. CLI commands below can also be run as `npx --yes supabase@2.117.0 ...`; no ORM or application dependency is added.

## Apply and seed

```sh
supabase db start
```

On first startup this initializes local Supabase PostgreSQL, applies migrations in filename order, and runs `seed.sql`. It does not start application features. For a fresh replay, `supabase db reset --local` **deletes and rebuilds the local database**, reapplies migrations, and seeds it. Do not edit already-deployed migrations; add a new timestamped migration.

Order:

1. `20260910000100_database_foundation.sql`: tables, constraints, indexes, membership helper, grants and RLS.
2. `20260910000200_queue_operations.sql`: controlled queue RPCs and execute grants.
3. `20260911000100_auth_sessions.sql`: private sessions/throttle counters, restricted authentication RPCs and credential-change revocation triggers.
4. `20260911000200_session_bound_queue_actions.sql`: validates and locks staff session/assignment before invoking the existing queue RPCs.
5. `20260911000300_manager_staff_management.sql`: manager-session-bound staff provisioning, atomic assignment updates, PIN reset and account-status changes; no new tables/columns.
6. `20260911000400_public_customer_flow.sql`: safe location/status RPCs, private idempotency records, atomic public join wrapper and cleanup function.
7. `20260911000500_manager_core.sql`: session-bound location/service configuration and four dashboard counts; server-only RPC grants, no new tables/columns or RLS changes.
8. `20260911000600_manager_analytics.sql`: service-only, session-scoped history aggregation and private timezone-aware calendar helper; no new tables/columns or RLS changes.
9. `20260912000100_location_isolation.sql`: replaces organization-wide report RPCs with required-location signatures, validates location ownership internally, preserves history-based staff aggregation, and adds IANA timezone validation/editing. No new tables or RLS changes.
10. `20260912000200_queue_realtime.sql`: data-free private queue Broadcast notifications; restrictive browser-role policies for queue topics. Existing queue/RLS authorization remains intact.
11. `20260913000100_customer_wait_estimate.sql`: adds derived, service-scoped waiting estimates to the protected public read RPCs; private bounded-history helper, no new tables, columns or RLS changes.
12. `20260913000200_location_lifecycle_and_display.sql`: safe location lifecycle actions and location-timezone display data.
13. `20260913000300_short_staff_ids.sql`: short automatic Staff IDs with existing global uniqueness preserved.
14. `20260913000400_analytics_chart_series.sql`: location-scoped time buckets derived from completed tickets.
15. `20260913000500_clear_location_analytics.sql`: protected location-history deletion, preserving live tickets and daily counters.
16. `20260914000100_customer_cancellation.sql`: token-authorized WAITING → CANCELLED transition and cancellation timestamp; existing queue numbers, history and Realtime trigger preserved.
17. `20260914000200_dynamic_counters.sql`: location counters, exclusive staff counter sessions, ticket attribution, protected management and queue integration.
18. `20260914000300_counter_views_and_capacity_eta.sql`: scoped operations views, active-lane ETA and likely call time, configuration invalidations.
19. `20260914000400_counter_revocation_locking.sql`: nonblocking idle cleanup during auth-session revocation.
20. `20260914000500_counter_claim_lease_lock.sql`: lock the initiating counter auth lease during CALL NEXT.
21. `20260914000600_archive_lifecycle.sql`: protected archive/restore/delete orchestration, archive guards and explicit skip-and-release.
22. `20260914000700_archived_counter_views.sql`: archived counter filtering and safe manager operations metadata.
23. `20260914000800_counter_recovery_presence.sql`: durable counter recovery independent of auth cleanup, informational heartbeat and complete manager serving traceability.
24. `20260914000900_stuck_ticket_recovery.sql`: confirmed manager recovery for SERVING tickets without operational counter sessions.

`seed.sql` is optional local/demo configuration, outside migration history; repeatable by stable IDs. Do not apply it in production. Follow [production deployment](../PRODUCTION.md) for hosted Auth settings, migration application and manager bootstrap.

For a hosted project, use `supabase link --project-ref <project-ref>`, review `supabase db push --dry-run`, then apply with `supabase db push`. This has **not** been run against a hosted project. `db push` does not seed by default; run `seed.sql` explicitly in a development project's SQL editor if wanted. Never seed real PINs or copy local database credentials into production configuration.

## Model and behavior

Seven domain tables: organizations, managers, locations, services, staff, staff_assignments, queue_tickets. The only supporting table, `service_daily_counters`, makes `(service_id, queue_date)` allocation atomic with `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`. Allocation and ticket insertion commit/roll back together. No application-supplied number or token is accepted.

- Composite foreign keys enforce organization/location/service/staff consistency. Each Auth user can belong to exactly one manager organization. Provision organizations/memberships through a trusted operator; a newly signed-up user cannot self-assign membership.
- Location slugs are globally unique because `/q/[locationSlug]` has no tenant key. Staff codes are globally unique normalized uppercase IDs because Staff ID + PIN has no tenant input. Names are not globally unique. Service names (case/outer-space insensitive) and prefixes are unique within a location.
- Each location has a PostgreSQL-valid timezone, default UTC. Kokkola uses `Europe/Helsinki`. A ticket snapshots its local queue date and service prefix; numbers grow beyond `999` without truncation. Configure timezone before accepting tickets. Existing ticket dates/numbers do not change with location/service edits.
- Tokens are independent cryptographically random UUID v4 values, unique and unrelated to display numbers. Treat ticket tokens as bearer credentials; future server endpoints must redact them from logs and prevent shared caching.
- Queue order is `(joined_at, id)` across all still-waiting tickets, including prior days. `FOR UPDATE SKIP LOCKED` lets concurrent callers claim different unlocked tickets. Under contention, a locked oldest ticket is skipped, so strict completion order is not promised.
- Staff may have multiple assignments but can serve only one ticket at a time. A second call while already serving fails with SQLSTATE `23514`. Complete and skip require the active staff member to own a SERVING ticket. Finishing an existing ticket remains possible if its assignment/service was subsequently disabled or removed.
- Skip means SERVING → SKIPPED by its owner, with a separate `skipped_at`; no waiting-ticket skipping, recall, or requeue. Terminal tickets cannot be changed through these RPCs. CHECK constraints enforce timestamp/state consistency.
- Historical tickets prevent deletion of referenced staff/services/locations/counters; manager Delete archives dependent entities, and Restore leaves them inactive. See [lifecycle contract](../lib/manager/LIFECYCLE.md). No calculated wait/service durations are stored. Later averages should use COMPLETED tickets only, with `default_service_minutes` as fallback.

## RPC contracts

All five original queue RPCs are **service_role only**, SECURITY DEFINER with an empty search_path and explicitly qualified relations. `anon`, `authenticated`, and PUBLIC cannot execute them. Staff HTTP routes use `perform_staff_queue_action`, which validates the session/staff/assignment before calling the original RPC. Customer HTTP routes use restricted wrappers around the existing creation/token lookup functions. See [authentication](../lib/auth/README.md) and [customer flow](../lib/customer/README.md).

| Function | Parameters | Result |
| --- | --- | --- |
| `create_queue_ticket` | `p_location_id`, `p_service_id`, `p_customer_name` | One ticket; checks active configuration, allocates number, generates token, inserts atomically. |
| `call_next_ticket` | `p_service_id`, `p_staff_id` | Zero or one ticket; checks active assignment and claims oldest unlocked WAITING ticket. |
| `complete_queue_ticket` | `p_ticket_id`, `p_staff_id` | One owned ticket changed from SERVING to COMPLETED. |
| `skip_queue_ticket` | `p_ticket_id`, `p_staff_id` | One owned ticket changed from SERVING to SKIPPED. |
| `get_queue_ticket_by_token` | `p_ticket_token` | Zero or one customer-facing record; excludes internal ID, organization ID and staff attribution. |

Invalid join input returns `22023`; invalid staff/assignment returns `42501`; missing/non-owned/non-serving completion or skip target returns `P0002`. Server endpoints translate these into sanitized HTTP errors; customer token misses use a generic 404.

`private.manager_organization_id()` is a stable, parameterless SECURITY DEFINER helper for authenticated RLS. It resolves `auth.uid()` against protected manager membership, avoiding recursive policies. Keep the `private` schema outside exposed API schemas.

## Access boundaries

RLS is enabled on all eight tables, and inherited default grants are revoked before explicit grants are added.

- **Public:** existing SELECT access to active configuration is unchanged. Customer HTTP routes return only safe display fields; ticket creation and private token lookup use server-only RPCs. No ticket enumeration or direct queue writes are granted.
- **Managers:** organization-scoped configuration/history reads; CRUD for locations, services and assignments. Safe staff metadata can be read/updated/deleted directly. The app's staff-management routes use `manage_staff` to verify the manager session, derive the organization, validate assignments and commit changes atomically. PINs are hashed by the trusted server; reset and disable revoke all staff sessions. Browser roles cannot execute this RPC or read/write `pin_hash`; there is no plaintext PIN column. See [staff management](../lib/staff/README.md).
- **Staff:** no Supabase Auth identities or RLS impersonation. Secure server sessions authorize service-role RPC calls. The session-bound entry point requires an active assignment for every action (including completing/skipping); original RPC behavior is preserved for trusted administrative callers.
- **Trusted server:** can provision configuration/hashed credentials. Even `service_role` has no direct queue/counter write grants; normal mutations use the RPCs. Database owners remain trusted administrative operators. Never expose privileged keys to browser code.

## Demo and validation

Seed: **Kokkola Health Services** → **Kokkola Health Centre**, slug `kokkola-health-centre`; Doctor **D / 14 min**, Nurse **N / 8 min**, Reception **R / 4 min**. No manager/Auth user, staff/PIN, assignment, or customer ticket is seeded. Provision credentials intentionally using the [authentication instructions](../lib/auth/README.md).

```sh
supabase db lint --local --level warning
python supabase/tests/database_test.py
```

The Python standard-library test runner uses `docker exec` against only the named local project container. It exercises actual SQL sessions, RLS/grants, constraints, concurrent joins/claims/terminal operations, rollback and daily counters, and seed idempotency. Randomly scoped fixtures are cleaned up in `finally`; test-only invalid hashes are never demo credentials. Run tests after migrations, and run Supabase CLI commands sequentially on Windows to avoid its telemetry file lock conflict.

## Generated types

`lib/supabase/database.types.ts` is actual CLI-generated output from the migrated local database, not a hand-written schema approximation. Regenerate after migrations, then run the application's typecheck:

```sh
supabase gen types --local --schema public > lib/supabase/database.types.ts
npm run typecheck
```

Use `--linked` instead of `--local` only when intentionally generating from a linked project. Inspect generation errors before keeping the output file. Generated types describe the schema, not RLS/column grants: staff metadata queries must explicitly select allowed columns instead of `select('*')`.

References: [Supabase migrations](https://supabase.com/docs/guides/local-development/database-migrations), [RLS and grants](https://supabase.com/docs/guides/database/postgres/row-level-security), [PostgreSQL row locking](https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE).
