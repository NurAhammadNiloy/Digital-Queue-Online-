# Authentication and sessions

Staff log in with **Staff ID + PIN**; managers use **Supabase Auth email/password**. Credentials are submitted only to same-origin server POST routes. Both roles receive a new random 256-bit session token in an HTTP-only cookie; only its SHA-256 digest is stored in `private.app_sessions`. No Supabase access/refresh token is sent to the browser: the server verifies the manager password, checks manager membership, signs out the temporary Supabase session, and issues its own session.

## Configuration and provisioning

Use Node.js 24 and apply all migrations before starting authentication. Copy `.env.example` to ignored `.env.local` and set:

| Variable | Source / exposure |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase Connect dialog; intentionally public. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Settings → API Keys: secret key or legacy service-role key; server-only, never share in browser/source control. |
| `AUTH_RATE_LIMIT_SECRET` | Generate 32 random bytes, e.g. `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`; server-only. |
| `APP_ORIGIN` | Exact site origin, no trailing slash; HTTPS required except loopback development/test origins. Set individually for Vercel preview/production. |

For local Auth/API tests start the Supabase stack (CLI 2.117.0):

```sh
supabase start -x storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor
supabase migration up --local
```

`supabase status` provides local-only keys. The integration tests retrieve these in memory and inject them into a child application process; they do not write an environment file. Never use those local keys in production.

- **Managers:** create a confirmed email/password user using Supabase Auth's trusted admin tooling, then insert its `auth.users.id` into `public.managers.user_id` with the intended organization. There is no public signup or automatic membership grant. Apply strong password requirements in hosted Supabase Auth as well as disabling unwanted signup providers.
- **Staff:** authenticated managers use `/manager/staff` to provision accounts and assignments, reset PINs, and enable/disable accounts. See [staff management](../staff/README.md). The trusted interactive helper `node --conditions=react-server scripts/hash-pin.mjs` remains available for operator bootstrap. Do not pass PINs on command lines, put them into SQL/seeds/logs, or use a browser hashing tool. Only the project's exact scrypt encoding is supported; imported Argon2/bcrypt credentials require an intentional secure PIN reset.
- No permanent demo credentials are created.

## Session and authorization rules

- Session lifetime: fixed **8 hours**, requiring a fresh login afterward. Login rotates the token and atomically deletes the supplied previous session; logout deletes the session before clearing the cookie. Multiple device sessions are allowed.
- Cookies: production `__Host-queue-staff-session` and `__Host-queue-manager-session`, both `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no Domain; development omits `__Host-` and Secure. Role-specific guards choose the corresponding cookie and independently validate its database role. Logging into or out of one role cannot replace/revoke the other role's session in another tab. Authentication never uses browser localStorage/sessionStorage. The former shared cookie is ignored; existing users must log in once after this update (unused database sessions expire normally).
- Session RPCs derive role/organization from trusted membership, never request parameters. Staff assignment lists are refreshed from active services/locations on every validation. Deletion, PIN/password changes, deactivation/bans and manager organization changes revoke sessions. Credential fingerprints also prevent issuance racing with a credential change. Password verification uses Supabase Auth; plaintext passwords are never persisted by the app.
- `perform_staff_queue_action` locks staff first, then session/assignment, and invokes the existing call-next/complete/skip RPCs inside the same transaction. Revocation cannot interleave after the authorization checks and before mutation. Completing/skipping through the application requires a current active assignment as well as ticket ownership.
- Manager API queries must explicitly filter using the organization from the validated session. The minimal location endpoint demonstrates this. Opaque app sessions are not Supabase JWTs: never use `auth.getSession()` or the browser Supabase client as the app's authorization guard. Existing Supabase RLS remains a separate defense for direct Auth-token access.
- `proxy.ts` provides early redirects only; protected layouts/pages and all APIs validate the database session independently. New routes must use the same guards and return private/no-store responses.
- Every state-changing endpoint (including login/logout) checks the exact configured Origin and rejects cross-site fetch metadata. Request bodies are limited to 4 KiB and unknown identity/role/organization fields are rejected. No permissive CORS is enabled.
- Manager/staff pages use `Referrer-Policy: same-origin`, allowing native login/logout form submissions to carry their actual Origin while suppressing referrers to external origins. `no-referrer` on these pages would make navigation POSTs send `Origin: null`, which remains rejected. Customer bearer-token pages and API responses retain `no-referrer`. Production uses the same strict configured-origin check; there is no localhost alias or missing/null-origin exemption.

## Endpoints

| Method / path | Input / behavior |
| --- | --- |
| POST `/api/auth/staff/login` | `staffCode`, `pin`; JSON or URL-encoded form. |
| POST `/api/auth/manager/login` | `email`, `password`; JSON or URL-encoded form. |
| GET `/api/auth/session?role=staff` or `?role=manager` | Safe identity/role/organization/expiry and staff assignments; 401 if invalid. Without a selector, returns the sole valid session or 409 when both roles are signed in. The selector grants no permissions. |
| POST `/api/auth/logout?role=staff` or `?role=manager` | Revokes and clears only the selected role's session; requires same Origin. Without a selector, works for a single cookie and rejects ambiguous two-cookie requests. |
| POST `/api/staff/queue/call-next` | `serviceId`; identity is derived from the session. |
| POST `/api/staff/queue/complete` or `/skip` | `ticketId`; only the caller's own permitted ticket. |
| GET `/api/staff/queue` | Staff-only queue snapshot; optional assigned `serviceId` and positive `page`. |
| GET `/api/manager/locations` | Own organization only; optional `locationId`, foreign IDs return 404. |

Minimal `/staff/login` and `/manager/login` pages exercise login. Failed login form submissions intentionally show generic JSON errors at this stage. `/staff/dashboard` provides the [staff serving flow](../staff/SERVING.md). `/manager` and `/manager/locations` provide [manager core administration](../manager/README.md), while `/manager/staff` reuses staff provisioning. The separate [customer flow](../customer/README.md) supports public joining/status. See [manager analytics](../analytics/README.md) and [operational Realtime](../realtime/README.md) for their existing authorization boundaries.

## Brute-force protection and operations

PINs use Node scrypt **N=131072, r=8, p=1**, a random 16-byte salt and 64-byte derived key, compared with `timingSafeEqual`. Unknown IDs/invalid hashes still perform the same KDF; unknown ID, wrong PIN, and inactive staff share the same 401 response.

PostgreSQL atomically enforces **5 login attempts per normalized account per 15 minutes**, plus **50 attempts per IP per 15 minutes**, before expensive verification. Limits include successful logins and are shared across Vercel instances. Identifiers are HMACed with the server secret. Only Vercel's overwritten `x-vercel-forwarded-for` is trusted when `VERCEL=1`; elsewhere all requests use a conservative shared origin bucket. No arbitrary forwarded header is trusted. Database/rate-limit failures fail closed with a generic 503.

Before public production launch, configure Vercel edge abuse controls and review these limits against expected traffic. Account throttling can be used to temporarily lock out a known ID, and application throttling cannot stop distributed network/resource exhaustion. scrypt consumes approximately 128 MiB per concurrent verification; provision runtime memory and cap traffic accordingly. A compromised privileged key remains administrative access and must be rotated.

Schedule `public.prune_auth_state()` from a trusted maintenance job (e.g. daily) to remove expired sessions and old throttling entries. Changing `AUTH_RATE_LIMIT_SECRET` resets identifier buckets. Do not log credentials, cookies, session digests, or customer ticket tokens. Password recovery, manager account management, auditing UI and optional MFA are not implemented.

## Tests

```sh
npm run build
npm run test:db
npm run test:auth
npm run test:staff
npm run test:serving
npm run test:browser-session
npm run typecheck
npm run lint
supabase db lint --local --level warning
```

Authentication tests use Node's built-in test runner and actual local Supabase Auth/PostgreSQL plus a production Next.js server on port 3100. They cover valid/invalid credentials, HTTP-only cookies, roles/tenants/assignments, queue ownership, rotation, expiration, logout/replay, credential-change revocation, CSRF, throttling and browser bundle isolation. Fixtures use random identifiers/credentials and are removed afterward. Run Supabase CLI commands sequentially on Windows to avoid its telemetry-file lock issue. No additional application or test dependency is required.

Security references: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [Node scrypt](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback), [Supabase password verification](https://supabase.com/docs/reference/javascript/auth-signinwithpassword), [Vercel request headers](https://vercel.com/docs/headers/request-headers).
