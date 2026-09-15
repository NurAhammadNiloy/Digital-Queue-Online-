# Production deployment

This repository is prepared for hosted Supabase + Vercel, but no hosted project has been verified, migrated, bootstrapped or deployed. Local `.env.local` and `.env.demo.local` remain local. Do not run `local:setup`, `seed.sql`, database resets or integration tests against production. No new database migration is needed for deployment preparation.

## 1. Environment and target selection

Choose one canonical HTTPS app origin (custom domain or stable Vercel production domain), a production Supabase project and a separate staging project. Use PostgreSQL 17, matching the migration development environment. For an existing hosted database, inspect its schema and migration history before applying anything; these migrations create application tables and are not an automatic import/merge procedure.

Set these in **Vercel → Project → Settings → Environment Variables → Production**, before the first build:

| Variable | Where to get it | Exposure |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project Connect dialog, HTTPS project URL | Public; safe to provide to the coding environment. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Same project's API Keys; `sb_publishable_…` | Public; safe to provide. Legacy anon JWT is not accepted by this app. |
| `SUPABASE_SERVICE_ROLE_KEY` | Same project's API Keys; dedicated `sb_secret_…` or legacy service-role JWT | Privileged. Configure directly in Vercel as Sensitive; only provide through a trusted secret/environment mechanism if coding access is needed. Never paste into source, browser code or chat. |
| `AUTH_RATE_LIMIT_SECRET` | Generate 32 random bytes locally, e.g. `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` | Server secret. Save in a password manager and Vercel Sensitive environment setting; same value across instances. Do not commit or paste into chat. |
| `APP_ORIGIN` | Your canonical Vercel/custom HTTPS app domain | Public configuration, but server-only variable; exact origin, no path/trailing slash. |

`NEXT_PUBLIC_` values are built into browser assets; changing them requires rebuilding. The privileged client is guarded by `server-only`; app sessions and Realtime authorization remain on the server. Do not configure a database password, Supabase account access token or manager password in Vercel. [Supabase key types](https://supabase.com/docs/guides/getting-started/api-keys).

Vercel's build command runs `check:production` before Next.js. It rejects missing/malformed values, localhost/example origins, incorrect key types and privileged `NEXT_PUBLIC_` names without printing values or contacting Supabase. This is a format check, not proof that keys match or the hosted schema is ready. If running it locally, use a dedicated ignored environment file: `node --env-file=.env.production.local scripts/check-production-env.mjs`; it deliberately does not load the development environment automatically.

For Preview, configure a separate staging Supabase project, independent rate-limit secret and exact stable preview origin. Do not expose production credentials/data to PR previews. Arbitrary deployment aliases are intentionally not trusted: visit the configured origin, or set the exact preview origin before rebuilding. Configure redirects from alternate production domains to the canonical domain in Vercel. Never derive allowed origins from request Host/forwarded headers or use wildcards.

## 2. Apply migrations, without demo seed

Use Node 24 and Supabase CLI 2.117.0 (the version used locally). Supabase account authentication and project database password are operator credentials, entered through the CLI's login/prompt or protected CI environment, never committed or included in command arguments. The project ref is non-secret, available from Project Settings or the dashboard URL.

```sh
npx --yes supabase@2.117.0 login
npx --yes supabase@2.117.0 link --project-ref YOUR_PRODUCTION_PROJECT_REF
npx --yes supabase@2.117.0 migration list --linked
npx --yes supabase@2.117.0 db push --linked --dry-run
```

Review the target ref, take/verify a backup for any existing data, then apply the reviewed migration set:

```sh
npx --yes supabase@2.117.0 db push --linked
npx --yes supabase@2.117.0 migration list --linked
npx --yes supabase@2.117.0 db lint --linked --level warning
```

The 24 SQL migrations run in filename order, `20260910000100_database_foundation.sql` through `20260914000900_stuck_ticket_recovery.sql`; see the full list in [supabase/README.md](supabase/README.md). Do not use `--include-seed`, `--include-all` or migration repair to conceal mismatched history. Do not edit applied migrations. Keep migrations separate from Vercel builds so concurrent deployments never race to apply SQL. `db push` does not configure hosted Auth settings. [Supabase environment workflow](https://supabase.com/docs/guides/deployment/managing-environments).

Keep the Data API enabled with `public` available; never expose `private` or `auth` as API schemas. Retain all migration grants, RLS, composite foreign keys and restrictive Realtime policies. Do not grant browser execution to protected RPCs. Do not add `queue_tickets` to a browser-readable Postgres Changes publication.

## 3. Hosted Auth and initial manager

In Supabase Authentication settings:

- Keep email/password authentication enabled; disable public signup and anonymous sign-ins. Leave unused OAuth/phone providers disabled. `supabase/config.toml` only configures the local stack; apply these settings to the hosted project explicitly.
- Set Site URL to the canonical `APP_ORIGIN`. This app uses server-side password verification and opaque cookies, not an OAuth/email callback. No redirect allowlist entry is required for password login. Remove localhost and wildcard production redirect entries; do not invent an `/auth/callback` route. Any future email recovery/invite flow needs an implemented callback first. [Redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls).
- Require strong manager passwords (recommended minimum 12 characters), configure the hosted password policy and enable leaked-password protection where supported. CAPTCHA is not integrated with these forms; enabling a token requirement without matching application support would break login. [Password settings](https://supabase.com/docs/guides/auth/password-security).
- Use trusted Auth administration to create a password user, with email confirmed only after verifying ownership. Do not use an invitation link as the bootstrap path: there is no invitation acceptance UI. SMTP is not needed for this direct admin bootstrap/password login; configure custom SMTP before using any supported Auth email workflow.

Create the initial membership in Supabase SQL Editor using [scripts/bootstrap-manager.sql](scripts/bootstrap-manager.sql). Copy it into SQL Editor or the ignored local `scripts/bootstrap-manager.local.sql`; keep the committed template unchanged. Replace its Auth user UUID, manager name, organization name (or existing organization UUID). No password enters SQL. It creates the organization and membership atomically, checks the Auth user is confirmed/active and refuses to overwrite or move an existing manager. On failure the transaction makes no changes. The Auth user is created separately; if membership fails, correct the inputs and retry without recreating the user.

Then sign in at `/manager/login`; create actual locations, set their IANA timezones, add services and enabled counters, and provision staff through `/manager/staff`. Never reuse local demo credentials. Store the initial manager password privately; it is not needed by the coding environment. Password recovery UI is not implemented; resets currently require a trusted Auth administrator.

## 4. Realtime and Vercel runtime

Use Vercel's Next.js preset, repository root, Node **24.x**, `npm ci`, and the committed `vercel.json` build command (`npm run build:vercel`). Keep the default Next.js output configuration; no static export, Edge-runtime conversion or custom backend. Choose a function region near the Supabase project. [Supported Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

The three event routes already use Node.js with `maxDuration = 60`. Each stream closes after 45 seconds and reconnects; verify the project's effective function limit permits 60 seconds and streaming is not buffered/cached. Do not add proxy/CDN caching for `/api/*`, manager/staff pages or private ticket URLs. Scrypt needs about 128 MiB per concurrent verification plus runtime overhead; allow sufficient function memory and review concurrency/edge abuse controls. [Vercel function duration](https://vercel.com/docs/functions/configuring-functions/duration).

Supabase Realtime must be enabled and support `realtime.send` and private Broadcast. Migration `20260912000200_queue_realtime.sql` installs the trigger and browser-deny policies. The server connects to Supabase over HTTPS/WSS using its privileged key; browsers receive only same-origin SSE invalidation signals. There are no additional browser Realtime credentials or permissive topic policies to configure. Monitor connection/channel/message limits for the intended number of simultaneous viewers. Polling remains the fallback; polling alone does not prove Realtime works. [Database Broadcast](https://supabase.com/docs/guides/realtime/broadcast).

Keep Vercel system environment variables enabled (`VERCEL=1` lets the existing rate limiter trust Vercel's overwritten client-IP header). Do not spoof it outside Vercel. Review deployment protection so public production queue/ticket pages are reachable by customers, while staging stays restricted. Keep the canonical production host stable: host-only cookies do not carry between aliases.

Production cookies remain `__Host-queue-manager-session` / `__Host-queue-staff-session`, Secure, HTTP-only, SameSite=Lax, Path=/ and no Domain. Sessions expire after eight hours; login rotates them, logout revokes them, and access is revalidated in the database. Origin validation still rejects missing/null/foreign origins on mutations. Do not override the manager/staff `Referrer-Policy: same-origin`, which native forms need; private customer pages retain `no-referrer`.

## 5. Launch and operations

1. Apply and verify migrations; configure hosted Auth/Realtime; bootstrap the manager.
2. Set target Vercel environment variables and canonical domain, then deploy. Configure counters at each location before new staff calls; existing serving tickets remain finishable. No secrets or database writes belong in the build. This workspace currently has no Git metadata; create/import a reviewed repository first if using Git deployment. `.gitignore` and `.vercelignore` exclude real environment files; review the upload/commit before publishing.
3. Complete the manual checks below before sharing queue URLs. Keep the previous application deployment available for rollback. Application rollback does not roll back migrations or restore deleted history; use reviewed forward fixes or a verified database restore plan.
4. Configure backups/restore access, monitor API failures and Realtime disconnects, and set capacity/abuse limits. Never log request bodies, Authorization/cookie headers, PINs, passwords, keys or private ticket URL tokens. Application diagnostics deliberately omit raw database errors; hosted logs/support tooling must preserve that boundary too.
5. Arrange daily trusted maintenance for the existing `select public.prune_auth_state();` and `select public.prune_customer_join_requests();` functions (Supabase Cron SQL job or an existing secured operator job). They remove expired session/throttle/idempotency state, not ticket history or queue-number counters. No public maintenance endpoint or scheduled queue-number reset is needed. No production job was installed in this preparation step.

## Final manual checks

- Load an active location, join, retain the private ticket URL, call/complete another ticket and skip a second ticket; verify live customer status, service waiting rows and selected-location manager counts.
- In the browser Network panel, verify event streams send `ready` and `queue-changed` on actions, reconnect after about 45 seconds, and polling recovers when the event connection is interrupted.
- Change manager location; check old streams close and foreign-location events/URLs do not reveal data. Remove a staff assignment and disable a staff account; existing access must fail.
- Confirm production cookies have the attributes above and reach `/api/staff/*`; both logins work at the canonical HTTPS origin, logout blocks protected pages/actions, and forged/missing Origin mutations are rejected.
- Verify QR opens the canonical public page, inactive locations reject joins/actions, location timezone timestamps/analytics are correct, and the first ticket after local midnight starts at 001 without resetting existing counters.
- Confirm an ordinary publishable-key request cannot read PIN hashes or execute protected RPCs. Inspect browser assets/network for accidental privileged credential exposure without copying secrets into logs.
- Verify manager bootstrap and current-password history confirmation work. Only test history deletion on deliberately disposable completed tickets; clearing history cannot reset numbering.

Automated test suites are intentionally outside this preparation request. Hosted migration/permissions checks, bootstrap, Realtime delivery, DNS and final browser acceptance remain pending until the production project and domain are configured.
