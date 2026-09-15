# Queue Realtime

Supabase private Broadcast carries only `{}` / `queue_changed` invalidations from the queue table trigger. Service topics update customer position/status and the selected staff queue; location topics update only the selected manager dashboard. No analytics history subscriptions, public queue-table replication, new dependencies or new secrets were added.

The app has custom HTTP-only sessions rather than browser Supabase Auth sessions. Next.js Node route handlers therefore bridge a narrowly scoped Supabase subscription to same-origin Server-Sent Events (EventSource). Browser messages contain only `ready`, `queue-changed`, `keepalive` or `access-changed` and `{}`. Records always come from the existing authorized HTTP endpoints.

[Dynamic counters](../counters/README.md) also send data-free invalidations when counter availability, sessions or assignment/configuration capacity changes. They refresh the existing location/service listeners; no browser database grants or extra dashboard listener are introduced. Per-service available-counter selectors are affected by counter changes anywhere at that same location. Time-based lease expiry is also recovered by polling.

## Authorization

- `/api/public/tickets/[token]/events` resolves the existing unpredictable ticket token to its service on the server. No browser-supplied location/service override is accepted. Terminal tickets need no stream. A waiting ticket receives service invalidations so its queue position can be refreshed; another customer's name or ticket token never enters a broadcast.
- `/api/staff/events?serviceId=...` requires the current staff session and exact active assignment. The server subscribes only to that selected service. Every forwarded event revalidates the session and assignment; a five-second check also closes idle revoked/expired sessions. Permission denial produces no further queue events, even on an already-open connection. Client reads and actions independently recheck permissions as before.
- `/api/manager/events?locationId=...` requires a manager session and independently verifies location ownership initially and before forwarding. It never subscribes to all organization locations. Switching the selected location unmounts the old counts component, aborts its read, closes its EventSource and opens a new scope.
- Private `queue:*` Broadcast topics have restrictive SELECT/INSERT policies denying anon/authenticated roles, even if unrelated permissive broadcast policies are added later. Only the trusted server's existing service-role client subscribes; no Supabase credentials or JWTs are sent to browser subscribers.
- Stream GETs have no state-changing side effects and may omit Origin, as native same-origin EventSource does. Explicit foreign/null Origin and cross-site fetch metadata are rejected. Existing POST/PUT Origin checks remain strict. CORS is not enabled. Streams are private/no-store/no-transform and have no-referrer policy.
- Admission uses the existing database rate limiter, HMACing identities/tokens: 12 connection attempts per identity per minute. Public streams additionally use the existing public read limit. Polling remains available when admission is throttled.

## Recovery and lifecycle

Customer/staff/manager reads retain 10s/5s/10s polling while visible, whether Realtime is connected or not. Realtime notifications are coalesced (250ms server, 300ms client, at least 1s between refreshes), reads do not overlap, and mutations are never retried. Retry-After suppresses hint-driven retries as well as polling. Hidden tabs release subscriptions; visible tabs reconnect and fetch a fresh snapshot. Terminal ticket status stops listeners and timers. A ready event refreshes once to close the initial fetch/subscribe race.

Each server stream lasts at most 45 seconds, below the route's 60-second maximum duration; the browser renews with bounded backoff. Failed subscriptions close after 8 seconds. Cancellation clears timers and removes the Supabase channel/socket. Missed events during reconnect are recovered through ready refreshes and polling. Broadcast-trigger failures log only SQLSTATE and never roll back valid queue operations.

## Local setup and operations

Keep the existing Supabase Realtime container running and apply `20260912000200_queue_realtime.sql`. From PowerShell with Node 24:

```powershell
npm exec --yes --package=node@24 --package=supabase@2.117.0 -- supabase start
npm exec --yes --package=node@24 --package=supabase@2.117.0 -- supabase migration up --local
npm exec --yes --package=node@24 -- node node_modules/next/dist/bin/next dev
```

No additional environment variables are needed. Do not exclude `realtime` from the local stack. Production must support unbuffered streaming responses and the configured function duration. Each visible viewer uses a bounded Next.js streaming invocation and a server-side Supabase connection; review Vercel execution/concurrency and Supabase connection limits for the intended traffic before deployment. No deployment or load-capacity certification is part of this change.

After a build, run `npm run test:realtime`. Integration tests require actual local Supabase Broadcast to deliver events; polling cannot make those tests pass. Client lifecycle tests cover fallback, bursts, visibility, disposal, late events after scope changes and retry backoff. Existing suites remain applicable.

Design references: [Supabase Broadcast](https://supabase.com/docs/guides/realtime/broadcast), [cached Realtime channel authorization](https://supabase.com/docs/guides/realtime/authorization), [Vercel streaming functions](https://vercel.com/docs/functions/streaming-functions).
