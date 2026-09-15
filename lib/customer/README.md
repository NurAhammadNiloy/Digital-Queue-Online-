# Public customer queue flow

Customers open `/q/[locationSlug]`, choose an active service, enter their name and receive a private `/ticket/[token]` URL. No account/session is created. [Realtime invalidations](../realtime/README.md) refresh status and queue position through the existing safe API. Polling remains every 10 seconds while visible, backs off on errors/429, and stops along with subscriptions on completed/skipped/cancelled/not-found tickets. Reads and refreshes never create tickets.

## API

| Method / route | Contract |
| --- | --- |
| GET `/api/public/locations/[locationSlug]` | `{ location: { name, organizationName, slug, services: [{ id, name, code, waitingCount, estimatedWaitMinutes }] } }`. Only service IDs needed for selection are exposed. Counts and estimates are snapshots at page load. |
| POST `/api/public/locations/[locationSlug]/tickets` | Body `{ name, serviceId }`, random UUID v4 `Idempotency-Key` header and exact `Origin`; 201 `{ token, statusUrl, ticket }`, including successful replay. `ticket` is optional display metadata (null if its bounded read fails); the token/URL remains authoritative. |
| GET `/api/public/tickets/[token]` | `{ ticket: { queueNumber, service, location, locationSlug, locationTimezone, status, joinedAt, calledAt, completedAt, skippedAt, cancelledAt, peopleAhead, estimatedWaitMinutes, estimatedCallAt, counterName } }`. No customer/staff names, internal IDs, other tickets or repeated bearer tokens. |
| POST `/api/public/tickets/[token]/cancel` | Empty JSON body `{}`, exact `Origin`; 200 `{ ticket }`. Only WAITING can become CANCELLED. 404 for malformed/unknown tokens, 409 if no longer waiting, 429 for throttling. |

## Customer cancellation

Estimates now use [active counter lanes and remaining serving workload](../counters/README.md#eta-model), retaining the existing historical/default duration model. No active capacity means no ETA. Likely call time uses the current database snapshot plus remaining ETA, formatted in the location timezone. SERVING tickets show their recorded counter name prominently; renaming/ending that counter later does not change the ticket's counter snapshot.

The private ticket page offers **Leave queue** only while WAITING, requires confirmation and prevents double submission. Cancellation uses only the unpredictable bearer token, never a queue number or internal ID. Anyone holding the private link can view and cancel its waiting ticket; keep it private. The endpoint retains strict Origin/4 KiB body checks, rejects query/extra body fields and has a separate database-backed cancellation IP bucket (10 attempts per 15 minutes), leaving existing join/read buckets unchanged.

The service-role-only `cancel_public_queue_ticket(uuid)` conditionally updates a WAITING row and sets `cancelled_at`. Row locking and predicate rechecks serialize it with CALL NEXT. If serving wins, cancellation returns 409; if cancellation wins, the existing waiting-only claim skips it. Unknown network outcomes trigger a status read, never an automatic mutation retry. Repeated cancellation returns 409 without modifying the original cancellation timestamp.

Cancelled tickets are retained and numbers are never reclaimed. Existing WAITING-only reads/counts/ETA and COMPLETED-only analytics naturally exclude them. The existing UPDATE Broadcast trigger invalidates service/location views, so staff, remaining customers and managers refresh normally; polling stays available. Customer cancellation also works if the location/service was deactivated while the ticket waited.

The cancelled page displays its timestamp in the location timezone and links back to services. An explicit **Join again** clears only that location's browser retry receipt so the next submission can create a fresh numbered ticket. Server retry records are preserved: retrying the original join still returns the original cancelled ticket. Manually verify the claim/cancel race using disposable tickets before production deployment.

Unknown/inactive locations share a generic 404. Malformed, unknown and internal-record UUIDs share the ticket 404. Inactive configuration blocks new joins; existing tickets remain readable. The schema has no opening-hours/capacity switch: location and service `active` flags currently define whether joining is allowed.

The join transaction resolves the slug itself. Existing `create_queue_ticket` verifies and locks the active service/location/organization relationship and performs allocation. Browser-supplied organizations, locations, queue numbers, states, timestamps and tokens are rejected. Names are normalized to NFC, trimmed, and whitespace runs become single spaces; blank names, control/format/surrogate characters and names over 200 Unicode characters are rejected. The existing 4 KiB body limit and unknown-key rejection remain.

All new RPCs are service-role-only, SECURITY DEFINER with empty search paths and execution revoked from PUBLIC/anon/authenticated. Existing grants, RLS, FKs, numbering and staff/manager authorization remain unchanged. Safe location/status RPCs expose explicit fields only; the privileged client/key never reaches the browser.

## Duplicate prevention

The form immediately guards against concurrent submissions and disables inputs during a request. It retains a UUID v4 request key, payload fingerprint and creation time in sessionStorage for up to 24 hours; no name or ticket token is stored there. Unavailable storage falls back to a ref in the mounted form. Uncertain network/503 results freeze submitted details and offer a retry of the same request. Definite validation rejection permits corrections. An explicit separate-visit button starts a new request.

`private.customer_join_requests` stores the key's SHA-256 digest, a payload fingerprint salted with the random key, ticket FK and creation time. Treat the request key as private too. A unique key and row lock serialize simultaneous copies; retry binding, ticket creation and existing counter allocation share a transaction. Failure rolls everything back. Identical normalized retries return the same token; different details with that key return generic 409. Replay works after location closure. Rate-secret rotation does not break fingerprints.

This prevents accidental double-clicks/same-key retries, not intentional duplicates. A new key, another tab/device, cleared storage or a new request after 24 hours can create another ticket. Shared customer names are not globally merged. Schedule `public.prune_customer_join_requests()` through trusted maintenance alongside `prune_auth_state()`; it removes records older than 24 hours without deleting tickets. Delayed maintenance retains older keys, which continue returning their original ticket.

## People ahead

For a WAITING ticket, count WAITING tickets in the same organization/location/service with a smaller `(joined_at, id)` tuple, including previous days. Exclude serving/terminal tickets; return null for non-waiting tickets. Lookup and count share one SQL snapshot and use the existing waiting index. No position integer or ETA is stored.

This matches `call_next_ticket` ordering. Its existing `FOR UPDATE SKIP LOCKED` can skip a row locked by another worker, so the count is labelled approximate and does not promise strict future call order. See [PostgreSQL locking semantics](https://www.postgresql.org/docs/17/sql-select.html).

## Waiting estimates

The protected read RPCs use the [capacity model](../counters/README.md#eta-model): each active counter contributes a serving lane, accounting for unfinished serving work and earlier WAITING tickets. The service duration is the mean of up to 100 valid COMPLETED visits from the past 30 days with at least five samples; otherwise it uses `default_service_minutes`. Estimates and likely call times are derived in the current database snapshot, never stored.

Realtime and polling refresh the estimate as work progresses or capacity changes. Waiting tickets show “About N min” or “You’re next” at zero, and a likely call time in the location timezone. No active capacity means no ETA; people ahead remains visible. Non-waiting tickets hide ETA. Before joining, an empty queue says “No one waiting”.

## Abuse protection and deployment

- Reuse atomic PostgreSQL throttling with separate HMAC namespaces: **10 creation attempts/IP/15 minutes** and **300 public reads/IP/minute**, across API and server-page reads. Invalid requests and retries count. API limits return 429 with Retry-After 900/60 seconds. A throttled/unavailable page returns a generic unavailable HTML message (HTTP 200) without querying ticket/location data. Failures never bypass throttling.
- Trust only Vercel's overwritten IP header when `VERCEL=1`; elsewhere use the conservative shared-origin bucket. Do not set VERCEL outside that trusted proxy. NAT users share quotas. Review expected traffic and configure Vercel edge abuse controls before launch; distributed abuse is not solved by these limits.
- Exact Origin and cross-site Fetch Metadata checks protect anonymous creation from drive-by submissions. No permissive CORS is enabled.
- Ticket URLs use the existing independent UUID v4 bearer token (122 random bits). Customer pages/APIs, including errors, disable caching, indexing, framing and referrer transmission. No third-party scripts/fonts/analytics were added. Anyone receiving a shared URL can read its ticket and cancel it while WAITING. Tokens do not currently expire; account-style ticket recovery is not implemented.
- Before launch, redact `/ticket/*`, `/api/public/tickets/*`, Idempotency-Key and request bodies from hosting/proxy/access logs and monitoring. Application code logs none of these secrets but cannot control an external log drain. Browser history/bookmarks necessarily contain the private URL.

Configure the variables in `.env.example` and apply all migrations before deployment.

## Validation

With local Supabase running and migrations applied:

```sh
npm run build
npm run test:customer
npm run test:staff
npm run test:auth
npm run test:db
supabase db lint --local --level warning
npm run typecheck
npm run lint
```

The customer suite uses Node's built-in runner, real Supabase/PostgreSQL and production Next.js on port 3102. It covers normalization, isolation, numbering, private responses/rendered HTML, concurrency/retry/rollback, actual staff call/complete/skip ordering, throttling, CSRF, grants, headers, browser bundles and retry-key lifecycle. Fixtures and child servers are cleaned up. Run Supabase CLI commands sequentially on Windows.

TypeScript permits explicit `.ts` imports under `noEmit` so Node 24 tests the same pure retry/normalization helpers without a test compiler/dependency.

Open join forms silently reload the existing safe location API every ten seconds while visible, preserving typed names and service selection. Inactive locations disable new joins; uncertain submissions retain their idempotent retry path. On a private waiting ticket, a zero-minute estimate displays “You’re next”. Before joining, an empty queue displays “No one waiting”. Private ticket timestamps use the location’s IANA timezone and `DD/MM/YYYY · HH:mm`; missing timezone metadata never falls back to the browser timezone.

Join delivery: preserve the UUID receipt after `join_public_queue` commits. The existing extra status/ETA snapshot has a two-second timeout and falls back to null; its failure never discards the token/URL. The RPC UUID return and generated `Returns: string` type are unchanged. The browser validates that token, stores its receipt only in component memory, disables new submissions, and performs a document replacement to the constructed same-origin `/ticket/[token]` path. A visible private link remains if navigation fails. Malformed/uncertain responses retain the submitted details and existing idempotency key for Check my ticket. No arbitrary response URL is used; request keys are not regenerated for navigation failure. Status/ETA reads, cancellation and realtime continue on the existing ticket page.
