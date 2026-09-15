# Manager staff provisioning

The separate [staff serving interface](SERVING.md) reuses these assignments and existing sessions at `/staff/dashboard`.

`/manager/staff`, `/manager/staff/new` and `/manager/staff/[id]` provide the minimal list, creation, edit, PIN reset and account-status interface. Only validated manager sessions can use them. This module does not implement dashboards; the separate [customer module](../customer/README.md) provides public joining/status.

## Server contract

All mutations check the exact configured Origin, reject unknown fields, cap request bodies at 4 KiB and use the existing manager session guard. Responses are private/no-store. IDs in URL paths are target records, never the acting identity. Query parameters and browser-supplied organizations/roles are rejected.

| Route | Body / response |
| --- | --- |
| GET `/api/manager/staff` | `{ staff: StaffView[] }`, own organization only. |
| POST `/api/manager/staff` | `{ name, staffCode?, pin, assignments }`; 201 `{ id }`. Blank/missing Staff ID generates one. |
| GET `/api/manager/staff/[id]` | `{ staff: StaffView }`; missing/foreign target returns 404. |
| PUT `/api/manager/staff/[id]` | `{ name, staffCode, assignments }`; replaces metadata and all service permissions atomically. |
| POST `/api/manager/staff/[id]/pin` | `{ pin }`; replaces the hash and revokes every staff session. |
| POST `/api/manager/staff/[id]/status` | `{ active: boolean }`; disabling revokes every staff session. |

`assignments` contains up to 25 `{ locationId, serviceId }` pairs with distinct services. Each service belongs to one location; staff can work across multiple locations as already supported by the schema. An empty array grants no queue permissions. Inactive locations/services may retain assignments but grant no operational access. The UI obtains configuration from explicitly tenant-filtered server queries. Every supplied pair is independently checked and locked inside the database transaction.

Staff IDs use the same trim/uppercase normalization as login and the existing global unique constraint. New automatic IDs use a private database sequence starting at S1000. Allocation runs inside the existing manager-authorized create transaction and skips custom-code collisions using the global unique index. IDs remain globally unique (and therefore unique within every organization) because login has no organization field. IDs contain no location/service information and are not secrets. Sequence gaps are normal; old IDs are never rewritten. Manual collisions, including other organizations' IDs, return the same 409 message without identifying the account or organization. Changing an ID changes future login lookup; current sessions still identify the same staff UUID.

The assignment picker pages through the complete organization location/service catalogs, including inactive and newly created configuration; it does not rely on seeded IDs or PostgREST's default row limit. Reopen/refresh staff editing after creating configuration in another tab. Removing a permission changes only assignment records. Completed tickets and staff attribution are preserved and remain in that location's historical reports. Queue reads reload current assignments through session validation on every request; call-next/complete/skip also recheck and lock the active assignment inside the existing queue transaction.

PINs use the existing server-only salted scrypt implementation (N=131072, r=8, p=1). They must be exactly 6–12 ASCII digits. PINs are submitted only to the same-origin server and cleared from form controls afterward; they are never persisted in browser storage, returned, logged or stored as plaintext. Metadata queries explicitly exclude hashes; only safe DTOs cross the server/client boundary. No dependencies or environment variables were added.

## Atomic authorization and revocation

The only migration adds `public.manage_staff`, a SECURITY DEFINER function with an empty search path and execution explicitly revoked from PUBLIC, anon and authenticated. It returns only the staff UUID. The privileged server passes the digest of the manager's opaque cookie; the function derives the organization from current manager membership itself. It accepts no organization parameter.

The transaction locks manager identity/membership, validates and locks the manager session, locks the target staff row, and validates location/service ownership before writing. Staff changes and assignment replacement commit or roll back together; unchanged assignment rows retain their IDs. Target locking coordinates with the existing session-bound queue RPC. An in-flight authorized operation can finish before a competing management change commits; operations after commit see the new state.

Existing RLS, composite foreign keys and global uniqueness remain unchanged. Direct authenticated Supabase access still has its existing manager-scoped metadata/assignment rights and cannot create staff or read/write hashes. The application uses its HTTP-only session and server endpoints, not browser Supabase Auth tokens.

Existing triggers revoke sessions on PIN/account-status changes. The new transaction also explicitly removes all staff sessions on reset/disable (even a repeated disable). Re-enabling never revives a deleted token. Login issuance checks the current credential fingerprint and active status under locks, preventing a verification racing with reset from issuing a stale session. Validation and queue operations reload current permissions, so assignment changes need no cookie update.

## Validation and operational limits

Run `npm run build`, then `npm run test:staff` with local Supabase running and all migrations applied. The built-in Node runner uses a real production Next.js process on port 3101, actual Supabase Auth/PostgreSQL, random isolated fixtures and cleanup. `npm run test:auth` and `npm run test:db` retain the previous regression coverage. Run CLI commands sequentially on Windows.

Hosted use requires the documented environment variables and a provisioned organization/manager. Managers configure locations and services through the administration UI. Before launch, review edge abuse controls, scrypt memory requirements and maintenance scheduling in [PRODUCTION.md](../../PRODUCTION.md).

Finish an active ticket before removing its service permission or disabling its staff member: the existing staff action guard intentionally requires current permissions for completion too. No automatic ticket reassignment was added.
