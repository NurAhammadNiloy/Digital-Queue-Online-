# Dynamic location counters

Counters are location-owned enabled/disabled resources, with no permanent staff or service assignment. `/manager/locations/[id]` creates, renames, enables/disables and force-releases them; `/manager` shows the same selected-location operations data. Unused counters can be permanently deleted after confirmation; counters with dependencies are archived. Counter-session history is retained. Composite foreign keys prevent location/service/staff attribution mismatches. Location Delete archives dependent records and blocks unresolved operational work.

## Staff sessions and queue actions

The staff dashboard selects location → assigned service → enabled available counter, then **Start serving**. Partial unique indexes enforce one unended counter session per counter and per staff member; row locks plus unique indexes handle simultaneous starts. Session selection is fixed until **End counter**. Queue reads remain assignment-scoped; CALL NEXT additionally requires an operational counter session for that exact service. It reuses `call_next_ticket` and its `FOR UPDATE SKIP LOCKED` queue ordering, then writes the counter/session/name snapshot in the same transaction. Two counters on one service claim different tickets from its shared queue.

Starting/ending a counter is rejected while that staff member owns any SERVING ticket. COMPLETE/SKIP still require the original staff identity and current assignment, including after signing back in with a new auth session. Legacy SERVING tickets without counter attribution remain finishable; they are not assigned invented historical counters. New calls require counters to be configured first. Counter renaming never changes ticket counter-name snapshots.

Manager force-release is rejected while the session has a SERVING ticket. It never completes/skips/deletes a ticket implicitly. A separate **Skip ticket & release counter** action requires explicit confirmation. Its server transaction matches the expected serving ticket and counter session, marks only that ticket SKIPPED, and ends that session; stale confirmations fail without changing another ticket. It can resolve a stuck session after staff access has been disabled. Disabling an occupied counter requires ending/releasing its session first. A force-released staff member must start another session before CALL NEXT.

Counter sessions are durable database work records, independent of the initiating login and any browser tab. The initiating auth digest is retained only as an internal nullable reference. Auth expiry, cleanup, network loss and browser closure do not end a counter or alter its SERVING ticket. Every action still validates a current staff login, enabled resources and current assignment under the existing locks. Archived/disabled/unassigned resources remain blocked. A new valid login resumes the same unended work session, not the old auth cookie.

Dashboard reads find the staff member's existing session and ticket server-side and prioritize that location/service over a stale tab selection. Current ticket, counter and timer come from database timestamps. No localStorage/sessionStorage or unload hook owns this state. Explicit End counter and manager release free idle counters. Explicit logout retains the existing behavior of releasing an idle counter, but preserves a serving ticket and its counter for the next login. Ended or archived sessions are never reopened by recovery or heartbeat.

## Presence and recovery

The dashboard sends an authenticated same-origin `POST /api/staff/heartbeat` with an empty body on mount, every 25 seconds, and on reconnect/visibility return. SQL derives staff and counter identity; updates are coalesced to at most once per 20 seconds per work session, including multiple tabs. No request-supplied ID, timestamp, role or organization is accepted. The heartbeat never creates/releases a session or changes a ticket.

Manager counters show **Online** for a heartbeat less than 90 seconds old, otherwise **Disconnected**. Existing sessions begin with unknown/stale presence until a heartbeat. Presence is informational: a suspended browser may appear disconnected while staff still physically serves. It does not change capacity, ticket status, counter occupancy or permissions. The badge ages using the server snapshot plus monotonic elapsed client time, avoiding dependence on the manager device wall clock. Presence-only writes notify the manager location topic; they do not invalidate all customer/staff service queues. Polling covers lost events and stale presence.

The manager dashboard includes serving start time/duration, current ticket/staff/service/counter and a complete SERVING ticket list matching its displayed currently-serving count from the same counter-operations snapshot. Legacy tickets without counter attribution are explicitly identified, not hidden or assigned invented counters. Idle disconnected counters can be explicitly force-released. Serving counters are never automatically released/skipped: normal release remains blocked, with a separate confirmed Skip ticket & release counter action. Current valid staff can reconnect and complete/skip normally; removed permissions still require manager recovery.

## Endpoints and access

- `POST /api/staff/counter`: `{action:"start",locationId,serviceId,counterId}` or `{action:"end"}`. Authenticated staff only; all assignment/resource checks repeated inside SQL.
- `POST /api/staff/heartbeat`: empty JSON body, authenticated staff presence only; strict Origin and protected RPC.
- `GET /api/staff/queue`: existing queue response plus own `counterSession` and selected-location `availableCounters`. Only own counter context and allowed enabled counters are returned.
- `GET /api/manager/locations/[id]/counters`: selected organization's location counters, safe occupant metadata, current ticket number and per-service active-counter/waiting/serving/served-today counts.
- `POST /api/manager/locations/[id]/counters`: `{action,counterId?,name?}`; actions create/rename/enable/disable/release, or `skip-release` with required `sessionId` and `ticketId`. Current manager session and location ownership are required in SQL. No tenant identity is accepted in the body.

Mutations use the existing strict Origin and bounded-body validation. Protected RPCs are service-role only. The new tables have RLS and no browser grants/policies; the internal live-session view is private. History columns are nullable only for legacy/unserved tickets; attributed tickets have composite scope constraints. Counter operations do not change numbering, cancellation, completed analytics or clear-history rules.

## ETA model

The existing service duration model is retained: mean of up to 100 valid COMPLETED services in the last 30 days, minimum five samples; otherwise configured `default_service_minutes`. No analytics result or estimate is stored.

Each effective active session is one serving lane. An idle lane is available now; a busy lane's estimated remaining work is average duration minus elapsed started time. When work is already overdue, another average duration is reserved as a conservative estimate, not a promised deadline. Early completion immediately frees the lane. Ended/archived/unassigned/disabled sessions contribute no capacity. Browser presence and auth expiry do not change durable serving capacity. With zero lanes the ETA/call time is null, even when no one is ahead.

For N waiting people ahead, select the (N+1)th call slot across the lanes' availability sequences; each earlier customer consumes one duration on the earliest available lane. The implementation uses an integer-second binary search over these ordered slot counts, avoiding a loop per customer and avoiding incorrect blind division. Two idle lanes can call the first two waiting customers immediately. Serving workload and WAITING order, including cancellations, determine subsequent slots.

`get_public_queue_ticket` calculates ETA and `estimatedCallAt = statement_timestamp() + remaining seconds` in one snapshot. UI rounds wait up to minutes, shows zero as **You're next**, and formats **Around HH:mm** in the location timezone. This is recomputed from the current snapshot on every refresh, never from original join time. No capacity means people-ahead information without a fake estimate. Existing public service cards use the same capacity model via `queue_wait_minutes`.

## Realtime and rollout

Queue changes retain existing Broadcast/SSE behavior. Counter/session changes invalidate the selected location and service topics at that location: counter availability affects every staff service selector there. Signals contain no row data. Assignment and active-configuration changes also invalidate capacity. Server SSE guards still recheck staff assignment and manager ownership. The manager dashboard reuses its existing single event listener for the new operations section. Polling recovers time-based expiry, disconnects and lost events; background reads preserve rendered data and reject aborted/stale responses.

Apply `20260914000200_dynamic_counters.sql`, `20260914000300_counter_views_and_capacity_eta.sql` `20260914000400_counter_revocation_locking.sql` and `20260914000500_counter_claim_lease_lock.sql` before deploying application code. No demo counters are inserted automatically. Create real counters at each location before expecting new staff CALL NEXT actions or capacity estimates. Existing queue tickets and daily counters remain unchanged.

Manual acceptance: create two counters and assign two staff to one service; race starts on one counter, start each on separate counters, race CALL NEXT, verify different oldest tickets and customer counter directions. Compare ETA with one vs two active lanes and with busy/idle lanes; complete early, cancel a waiting ticket, end/open a counter and observe recalculation. Verify busy end/release/disable rejection, idle logout/release, expiry/revocation, renamed counter history, cross-location denials and realtime/polling recovery.

Archive/restore: apply migrations `20260914000600_archive_lifecycle.sql` and `20260914000700_archived_counter_views.sql` before the matching application code. Manager management reads use `?view=all` for Active/Archived tabs; dashboard and staff reads exclude archived records. See [lifecycle contract](../manager/LIFECYCLE.md).

Recovery rollout: apply `20260914000800_counter_recovery_presence.sql` after all prior migrations, before the matching app build. Existing tickets and unended counters remain intact; already-ended historical sessions cannot be reconstructed automatically.

Manual recovery acceptance:
1. Start serving a ticket. Close all staff tabs or disconnect the staff browser. After 90 seconds, check manager Disconnected, unchanged counter/ticket, advancing timer and matching serving count/list.
2. Reopen the dashboard, then repeat with an expired/deleted browser cookie and sign in again. Verify the same counter/session/ticket, correct location/service, continued timer and COMPLETE/SKIP without choosing another counter.
3. Repeat disconnection with an idle counter. It stays occupied until explicit manager release, End counter or explicit idle logout. Another staff member cannot claim it first.
4. Confirm normal release is blocked while serving. Cancel and then confirm Skip ticket & release; verify the exact ticket is SKIPPED, customer updated and counter released. A stale confirmation must not skip a newer ticket.
5. Check two open staff tabs, manager-selected location changes, revoked staff permissions, missing/foreign Origin, expired credentials and heartbeat after release. No heartbeat may recreate work, bypass access checks or mutate a ticket.
6. Disconnect Realtime separately: polling and badge aging still work without resetting displayed queue state.

## Stuck / legacy SERVING ticket recovery

Migration `20260914000900_stuck_ticket_recovery.sql` adds manager-only `resolve_stuck_serving_ticket` and a `needsRecovery` flag to each serving-table row. The flag means no matching operational counter session exists, using the same `private.live_counter_sessions` definition as staff operations. Merely being Disconnected does not qualify. Legacy null-counter tickets qualify without inventing a counter.

`POST /api/manager/locations/[id]/tickets/[ticketId]/resolve` accepts only `{action:"skip"|"complete"}`. Current manager authentication, strict Origin and database location/organization checks apply. SQL locks staff, ticket and relevant configuration, rechecks SERVING and absence of an active counter, and changes only status plus the normal terminal timestamp (`greatest(clock_timestamp(),started_at)`). Concurrent work/configuration changes either serialize or return a retryable conflict. Execution is service-role only. No counter sessions are ended/modified and no attribution or ticket is deleted.

Resolve defaults to **Mark skipped & close (recommended)** and requires confirmation. **Mark completed** explicitly warns that the original start/staff attribution enters completed analytics. **Cancel** closes the form without any request; it does not set the customer CANCELLED status. Skipped tickets leave operational serving counts and remain excluded from completed-only analytics. Existing ticket Broadcast/SSE and polling update all authorized views.

Manual checks: use a disposable SERVING ticket with no active counter session; it should show Stuck / legacy ticket and Resolve. Cancel first and verify no change. Confirm Skip and verify the ticket remains with original staff/service/location, null counter, SKIPPED and absent from serving/completed counts. Use another disposable orphan to confirm Complete has a normal completion timestamp and follows existing completed analytics. Verify normal active sessions (including disconnected staff) offer no orphan Resolve, cross-organization/location IDs are rejected, and stale double confirmations cannot alter terminal tickets.
