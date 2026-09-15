# Manager entity lifecycle

Staff, services, counters and locations have `archived_at`; database CHECK constraints require archived records to be inactive. Normal manager lists exclude archived rows; Archived tabs expose them only to their organization manager. Staff choices and effective counter capacity exclude archived records. Public operational RPCs retain active-entity checks. Historical ticket metadata/analytics joins remain intact.

## Confirmed actions

`GET /api/manager/lifecycle/[kind]/[id]` previews Delete (`archive` or `permanent-delete`) and live-work blocking. `POST` accepts only `{action:"archive"|"permanent-delete"|"restore"}` after the UI confirmation. Both resolve the manager organization from the validated opaque session; mutations additionally enforce strict Origin. SQL independently checks ownership and live dependencies. No tenant or authorization attributes are accepted from the browser.

- No history/dependencies: permanent deletion of the single entity. Foreign keys still apply. New dependencies after preview reject the permanent delete and require a new preview/confirmation.
- History/dependencies: archive and deactivate, retaining identity, tickets, daily sequence counters and counter-session history.
- Staff or counter with a SERVING ticket: blocked. Idle counter sessions end when archived. Staff archive removes assignments and revokes all auth sessions.
- Service or location with WAITING/SERVING tickets or any unended counter session: blocked. Resolve tickets and explicitly end/release sessions first. Service archive removes its assignments.
- Location archive also archives its services/counters and removes its location assignments. Children stay archived when the location is restored.
- Restore preserves identity/history and remains inactive. Restore the parent location before its children. No old counter/auth session or assignment returns. Explicitly activate and reassign after restore.
- Archived records with retained dependencies cannot be permanently deleted. Their Delete control explains why without changing history.

## Concurrency and permissions

Lifecycle transactions take organization staff locks followed by the target (and location children) using NOWAIT. This serializes rare lifecycle writes with queue/counter actions, returning a retryable conflict rather than waiting through an inverse lock order. Dependency and live-work checks occur after locks. Child creation and assignment guards lock their parent rows and reject archived records. Existing partial unique counter-session indexes, attribution foreign keys and queue row locking remain unchanged.

Lifecycle RPCs are SECURITY DEFINER with empty search paths and service-role-only execution. Dynamic table identifiers come from a four-value whitelist. Archive-field changes require the internal transaction flag; legacy browser write grants on locations/services/staff/assignments are revoked because application writes already use trusted manager RPCs. RLS and safe staff SELECT column grants remain; PIN hashes are never returned. Browser roles cannot set the lifecycle flag through a callable RPC.

Realtime uses the existing data-free invalidations. Ending sessions, removing assignments and changing active entities notify affected scopes; polling remains a fallback. The explicit counter skip-and-release transaction generates normal ticket/session invalidations. It requires the expected ticket/session IDs, protects against stale confirmation, and never changes a different ticket.

## Manual acceptance

1. In each entity type, Delete an unused record and confirm permanent removal. Cancel the confirmation first to verify no change.
2. Delete a record with completed history and confirm Archive. Check normal/Archived lists, existing ticket attribution, analytics, and unchanged daily numbering.
3. Try archive/delete with serving staff/counters and waiting/serving services/locations; verify rejection. End idle service/location counter sessions before retrying.
4. Restore a location, then services/counters; verify all stay inactive and assignments do not return. Restore staff and verify old cookies remain invalid and no permissions reappear.
5. Verify archived resources never appear in staff location/service/counter selectors or allow calls/joins, including an already-open page. Try foreign-organization IDs against each endpoint.
6. With a serving ticket, normal Force-release is disabled/rejected. Cancel the separate Skip ticket & release confirmation, then confirm it; verify SKIPPED, released counter and realtime customer/staff/manager updates. Complete the ticket from another client while the confirmation is open and verify it cannot skip a later ticket.
7. Race two staff starts at one counter; then race CALL NEXT from two counters on one service. Check one session per staff/counter, different oldest tickets, capacity-aware ETA and timezone call time, cancellation and polling recovery.

Apply the ordered migrations before deploying the corresponding app build, then perform the manual checks above.
