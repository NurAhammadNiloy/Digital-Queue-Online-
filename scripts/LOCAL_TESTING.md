# Repeatable local manual testing (PowerShell)

Use Docker Desktop and Node.js **24**. These commands select Node 24 without changing your global installation.

From the repository root, with Docker running:

```powershell
npm exec --yes --package=node@24 --package=supabase@2.117.0 -- supabase start
npm exec --yes --package=node@24 -- node --conditions=react-server scripts/setup-local.mjs
```

Stop any existing Next.js process with **Ctrl+C** in its terminal, then run:

```powershell
npm exec --yes --package=node@24 -- node node_modules/next/dist/bin/next dev
```

If Node 24 is already your default, `npm run local:setup` and `npm run dev` are equivalent. Do not run `db reset` for routine setup: it deletes local data.

The setup script:

- Reads **current local** API URL, `PUBLISHABLE_KEY` and `SERVICE_ROLE_KEY` from Supabase CLI, without printing keys. It refuses hosted URLs.
- Applies pending local migrations and the existing idempotent seed; existing queue history is preserved.
- Writes ignored `.env.local` using `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `AUTH_RATE_LIMIT_SECRET` and `APP_ORIGIN=http://localhost:3000`. The older `NEXT_PUBLIC_SUPABASE_ANON_KEY` variable is not used by this project. Unrelated settings and an existing valid rate-limit secret are preserved.
- Creates a confirmed local Supabase Auth manager in the seeded organization and staff using the existing scrypt PIN implementation. Demo staff receive assignments to the seeded location's active services. Rerunning restores missing demo assignments, but does not reset changed passwords/PINs or enable disabled accounts silently.
- Verifies the public-location RPC. It never weakens RLS or grants browser execution of protected RPCs.

## Demo login

Read the generated local-only credentials on your own computer:

```powershell
Get-Content .env.demo.local
```

- Manager: `http://localhost:3000/manager/login`, email **demo-manager@queue.example.test**, password from `MANAGER_PASSWORD`.
- Staff: `http://localhost:3000/staff/login`, Staff ID **DEMO_KOKKOLA**, PIN from `STAFF_PIN`.
- Customer: `http://localhost:3000/q/kokkola-health-centre` (Doctor, Nurse, Reception).

Use **localhost:3000** consistently when testing forms because `APP_ORIGIN` protects mutation requests against cross-origin submissions. With a supported Node 24 development server, both roles use HTTP-only local cookies.

Manager and staff can now be signed in in separate tabs of the same browser profile: each role has its own HTTP-only cookie and logout. If a staff action is denied, its message stays visible; only an expired/invalid staff session redirects to login. Manager counts and customer ticket status update automatically while visible; polling provides a fallback within 10 seconds when Realtime is disconnected.

Passwords/PINs are randomly generated once and saved only in ignored `.env.demo.local`. Both local environment files are covered by `.gitignore`. They are never production credentials; do not commit, publish, reuse in production or paste them into screenshots/logs. The database stores the manager password via Supabase Auth and a scrypt hash for the staff PIN, never plaintext. If the demo credential file is lost or credentials were changed, setup refuses to reset existing accounts silently; recover the file or intentionally reset through trusted Auth administration/manager PIN reset.

## Location isolation check

1. Open `/manager/locations`; create two locations with different IANA timezones and a service at each.
2. In `/manager/staff`, assign A only to the first service, B only to the second, and C explicitly to both. Newly created locations/services appear when staff editing is reopened/refreshed.
3. Join each public `/q/[slug]` page. Sign in as A, B and C and check their available location/service combinations. Different staff identities need separate browser profiles or sequential staff logins; manager and staff roles may share a profile.
4. Complete a ticket as C at each location. Remove C's permissions, then verify C loses queue access while both location reports retain C's completed history. Finish active tickets before removing assignments in normal use.
5. Select each location on Dashboard and Analytics, and apply each analytics date filter. Compare counts/history; there is no all-locations option. The selected IANA timezone is displayed.

Automated coverage: after migrations and a build, run `npm run test:locations` and `npm run test:analytics` (Node 24). Report API calls must now include `locationId`; missing selectors return 400, and foreign locations return 404.

## Realtime check

Keep Supabase Realtime running (`supabase start`, without excluding realtime), apply pending migrations and restart Next.js. Open a customer queue page, staff dashboard and the manager dashboard with the same location selected. Join a ticket and watch the staff queue and manager waiting count update automatically. Call, complete and skip tickets; watch the private customer page and operational counts. Switch the manager location and confirm the other location's changes do not update its counts. Remove a staff assignment in manager staff editing and confirm queue access disappears.

For fallback testing, block only `/api/*/events*` requests in browser network tools, leaving normal queue/ticket/dashboard API requests enabled. Counts/status continue polling while visible (staff 5s; customer/manager 10s). Unblock and reload to verify realtime resumes. Realtime delivery itself can be distinguished by a `queue-changed` EventSource frame followed by the authorized API read; polling alone is not evidence of realtime.

See [Realtime architecture and tests](../lib/realtime/README.md).

## Waiting estimate check

Apply all migrations. Use a dedicated service with an 8-minute default and fewer than five recent completed visits. Start one idle counter session and join three tickets: the third should show two people ahead and about 16 minutes. CALL NEXT should show the called ticket’s counter; the remaining estimates include that counter’s unfinished workload. Start a second authorized counter and verify parallel capacity reduces the wait. Complete or cancel tickets and verify estimates update. With no active counters, show people ahead without an invented ETA. See the [capacity model](../lib/counters/README.md#eta-model).

## Diagnosing an unavailable page

A page HTTP 200 alone is not success: verify that it contains the service selection and **Join queue** form. `/api/public/locations/kokkola-health-centre` should return 200 with the location and its three active services.

During development, the server terminal logs `[queue:development]` with a fixed operation label and safe configuration reason or underlying database error code (for example `PGRST202` for an RPC missing from the schema cache, or `42501` for permission denial). Arbitrary SDK messages/details, request bodies, URLs, customer names, tokens, PINs and keys are omitted. Browser responses stay generic, and these diagnostics are disabled in production.

After changing `.env.local`, restart Next.js. For `next start`, rebuild first because public environment values are embedded during the build. Do not change RPC permissions to fix missing application credentials: public requests intentionally go through trusted server routes using the service-role client.
