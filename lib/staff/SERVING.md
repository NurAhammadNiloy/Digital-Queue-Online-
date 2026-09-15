# Minimal staff serving flow

Existing Staff ID/PIN login now sends successful form submissions to `/staff/dashboard`. `/staff/login` and the protected `/staff` session page remain; `/staff` links to the dashboard. Existing HTTP-only sessions and logout are reused.

The current flow requires **Location → assigned Service → available Counter → Start serving** before new calls. End the counter session before changing service/location; ending/starting is blocked while a ticket is SERVING. Idle logout releases the counter. See [counter sessions and capacity](../counters/README.md) for the current workflow, lease/security rules and rollout requirements. Legacy serving tickets can still be completed/skipped without invented counter attribution.

The dashboard shows the staff name, active location/service assignments, selected counter, the selected service's waiting queue and only the caller's current serving ticket. Service/location selectors are locked during a counter session. Waiting rows are ordered by `(joined_at, id)` across all dates, exactly as in the existing call-next RPC. Pagination uses 50 rows per page plus an exact count, rather than silently hitting Supabase's default row cap.

## Read access

`GET /api/staff/queue` accepts only optional `serviceId` and `page` query parameters. The existing database session guard runs on every request. Staff identity and organization come from that session; the service must be in its current active assignment list. Queries explicitly filter organization/location/service and select only necessary fields. Serving reads also filter by the caller's staff ID. No PIN hashes, customer bearer tokens, other staff's serving records or privileged credentials are returned.

If permission for an already-serving ticket is removed, the response contains only `servingAccessBlocked: true`, hiding that ticket's customer details. The dashboard blocks new calls and explains that access must be restored. It does not reassign tickets or relax existing action permissions. Disabled/expired/revoked sessions fail the existing guards; manager sessions cannot access this interface.

Read queries are separate current snapshots and may race with another worker's action. The UI never treats its displayed state as authorization; existing protected RPCs revalidate and lock everything when an action is submitted. No database migration, RLS/grant changes or concurrency logic were introduced.

## Actions and refresh

CALL NEXT, COMPLETE and SKIP use the unchanged `/api/staff/queue/[action]` POST routes and `perform_staff_queue_action` wrapper. The existing backend retains ticket ownership, assignment checks, row locking and the one-serving-ticket-per-staff invariant. Completing or skipping always targets the caller's displayed serving ticket, not a waiting row.

An immediate ref guard prevents duplicate submissions, controls are disabled while pending, and every action is followed by a fresh server read, including conflicts and uncertain network outcomes. Mutations are never automatically retried. Pending reads are cancelled and versioned so an older polling response cannot overwrite the action refresh. Failed refreshes hide queue details and disable serving actions until a fresh read succeeds; logout stays available.

Only HTTP 401 redirects to staff login. Permission/CSRF denials (403), conflicts (409), throttling and service errors remain visible with recovery guidance. A revoked service selection first reloads current permitted assignments. Staff and manager use separate role cookies, so signing in or logging out in a manager tab does not affect staff serving.

`npm run test:browser-session` adds a production-server regression on localhost:3108 using libcurl's cookie jar (curl must be installed). It accepts server Set-Cookie headers and enforces host/Path/Secure/expiry rules instead of manually supplying cookies. It covers both roles in one jar, call/complete/skip, public polling data, manager counts, role-scoped logout, expiry and error classification. SameSite=Lax is asserted; Chrome remains the check for actual UI clicks, browser SameSite behavior and polling timers.

[Realtime invalidations](../realtime/README.md) subscribe only to the selected permitted service through a session-validated server stream. Polling remains every five seconds while visible, never overlaps actions/reads, and supports manual refresh. A selected service that has been revoked closes its stream and triggers a fresh default-selection read based on current permissions. Session failure clears the view and returns to login. Responses remain private/no-store; queue/customer data is never written to browser storage. No new dependencies are required.

## Validation

With local Supabase running and a production build available, run `npm run test:serving`. It uses Node's built-in runner with real Supabase/Auth/PostgreSQL and a production Next.js server on port 3104. Isolated fixtures cover page/API protection, form login, scoped metadata, ordering/pagination, call-next, complete, skip, ownership, same/different-staff concurrency, permission changes, session expiry, logout and private responses. Fixtures and child servers are removed afterward.

Retain `test:auth`, `test:staff`, `test:customer`, `test:db`, database lint, build, typecheck and ESLint checks. Automated coverage includes rendered HTML and HTTP flow; no interactive tablet/browser pass is claimed. See [production requirements](../../PRODUCTION.md) for logging and abuse controls.
