# Digital Queue Management System

Next.js App Router, strict TypeScript, Tailwind CSS, Supabase, PostgreSQL queue operations, secure staff/manager sessions, staff provisioning, public customer join/status, staff serving, manager administration, MVP analytics and scoped Realtime with polling fallback.

## Development

Use Node.js 24 LTS (see `.nvmrc` and `package.json`) and npm.

For the local queue, manager and staff flows, follow [local manual testing and demo credentials](scripts/LOCAL_TESTING.md). With local Supabase running, `npm run local:setup` applies pending migrations/seed and writes the ignored local environment and demo credential files. The static root page alone does not verify Supabase configuration.

```sh
npm ci
npm run dev
```

The static root page builds and runs without Supabase credentials. It contains only the application name. Optional database demo configuration is seeded separately.

```sh
npm run lint
npm run typecheck
npm run build
npm start
```

`typecheck` generates Next.js route types before checking TypeScript, including on a clean checkout. Tailwind v4 uses `postcss.config.mjs` and `app/globals.css`; it does not need a Tailwind config file.

ESLint is pinned to 9.39.5 because the React/import/accessibility plugins in the current Next.js preset do not support ESLint 10. npm marks ESLint 9 as deprecated; upgrade it together with compatible Next.js lint plugins.

## Environment

Copy `.env.example` to `.env.local` when connecting a Supabase project. Get the project URL and **publishable** key (`sb_publishable_...`) from the project's Connect dialog or Settings > API Keys in the Supabase dashboard. Use the publishable key; legacy JWT anon keys are not supported.

Both `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are browser-visible values and safe to place in the coding environment. Database authorization must be enforced by RLS. Configuration is checked when a Supabase client is created, and errors never print key values. Real environment files are ignored by Git; only `.env.example` belongs in source control.

Authentication and public customer endpoints require server-only `SUPABASE_SERVICE_ROLE_KEY`, `AUTH_RATE_LIMIT_SECRET`, and an exact `APP_ORIGIN`. See `.env.example`, [authentication setup](lib/auth/README.md) and [customer deployment notes](lib/customer/README.md). Never put privileged keys in `NEXT_PUBLIC_` variables, source control, or browser code.

## Structure and boundaries

- `app/`: pages, API routes, layouts and global styles.
- `lib/supabase/config.ts`: lazy validation of public Supabase configuration.
- `lib/supabase/client.ts`: browser client using cookie storage through `@supabase/ssr`.
- `lib/supabase/server.ts`: anonymous server data access; `admin.ts`: server-only privileged client.
- `lib/auth/`: PIN hashing, password verification, HTTP/CSRF guards, shared throttling, and revocable sessions.
- `lib/staff/`: validated staff provisioning and safe metadata access; see [staff management](lib/staff/README.md) for API contracts and security decisions.
- `/staff/dashboard`: assigned-service queue, durable counter sessions, call-next/complete/skip and live updates; see [staff serving](lib/staff/SERVING.md).
- `lib/customer/`: public location lookup, validated/idempotent joining, safe ticket status and throttling; see [customer flow](lib/customer/README.md).
- `app/q/[locationSlug]`, `app/ticket/[token]` and `components/customer/`: customer join form and live private ticket page.
- `proxy.ts`: preliminary protected-page redirects and private cache headers. Every protected page/API also validates the actual database session. Both roles use HTTP-only opaque cookies.
- `app/staff/login`, `app/manager/login`: credential forms; `/staff` redirects authenticated staff to their serving dashboard.
- `app/manager/(protected)/`, `lib/manager/` and `components/manager/`: location-scoped operational counts, counters, location/service administration and public-location QR download/print; see [manager core](lib/manager/README.md).
- `/manager/analytics` and `lib/analytics/`: filtered completion counts and timestamp-derived service/staff averages; see [analytics definitions and tests](lib/analytics/README.md).
- `app/manager/(protected)/staff/` and `components/manager/staff-forms.tsx`: staff list, create, edit, PIN reset and enable/disable forms.
- `app/api/`: authentication, protected staff/manager operations, and public location/join/ticket-status routes.

`supabase/` contains ordered migrations, a separate seed, and database integration tests; see [database setup and RPC contracts](supabase/README.md). `lib/supabase/database.types.ts` is generated from the local database and used by all Supabase clients.

Customers have no accounts. Managers verify email/password with Supabase Auth on the server; staff use Staff ID + a scrypt-hashed PIN. Both use opaque database-backed sessions; their credentials/tokens never enter browser storage or JSON responses. Customers receive a separate random ticket bearer URL. Only customer retry keys/fingerprints use sessionStorage. Existing database RLS remains unchanged.

## Vercel

Follow [PRODUCTION.md](PRODUCTION.md) for hosted migrations, Auth settings, manager bootstrap, Realtime requirements and the deployment checklist. The committed `vercel.json` uses the Next.js preset, `npm ci` and `npm run build:vercel`, which validates production environment formats before building. Use Node.js 24.x. Local `npm run build` remains unchanged. Set public and server-only variables separately per environment before building.

Integration follows the [Supabase SSR guide](https://supabase.com/docs/guides/auth/server-side/nextjs), [Tailwind Next.js guide](https://tailwindcss.com/docs/installation/framework-guides/nextjs), and [Vercel Node.js runtime configuration](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).
