"use client";
import { useRef, useState } from "react";
import type { CounterOperations } from "@/lib/counters/types";
import { LifecycleActions } from "./lifecycle-actions";
import { ResolveTicket } from "./resolve-ticket";
import { CounterPresence } from "./counter-presence";
import { ElapsedTime } from "@/components/staff/elapsed-time";
import { locationTime } from "@/lib/shared/location-time";
import { StatusBadge } from "@/components/ui/status-badge";

export function CounterPanel({ locationId, data, manage = false, recover = false, parentArchived = false, refresh }: {
  locationId: string; data: CounterOperations | null; manage?: boolean; recover?: boolean; parentArchived?: boolean; refresh?: () => Promise<unknown>;
}) {
  const busy = useRef(false);
  const [archivedView, setArchivedView] = useState(false);
  const visibleCounters = data?.counters.filter((counter) => counter.archived === (manage && archivedView)) ?? [];
  const visibleServices = data?.services.filter((service) => !service.archived) ?? [];
  const [pending, setPending] = useState(false), [message, setMessage] = useState("");
  async function act(action: string, counterId?: string, name?: string, form?: HTMLFormElement) {
    if (busy.current) return;
    const counter = data?.counters.find((c) => c.id === counterId);
    if (["disable", "release"].includes(action) && !window.confirm(action === "release"
      ? `Force-release ${counter?.name}? ${counter?.staffName ?? "Staff"} will need to start a new counter session. A serving ticket must be completed or skipped first.`
      : `Disable ${counter?.name}? Staff cannot start new sessions at this counter.`)) return;
    if (action === "skip-release" && !window.confirm(`Skip ticket ${counter?.ticketNumber} and release ${counter?.name}? This explicitly changes the serving ticket to SKIPPED and ends the staff counter session. This cannot be undone.`)) return;
    busy.current = true; setPending(true); setMessage("");
    try {
      const response = await fetch(`/api/manager/locations/${locationId}/counters`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, counterId, name, ...(action === "skip-release" ? { sessionId: counter?.sessionId, ticketId: counter?.ticketId } : {}) }),
        cache: "no-store", signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Counter update failed. Refresh and try again.");
      if (action === "create") form?.reset();
      if (action === "rename") form?.closest("details")?.removeAttribute("open");
    } catch (error) {
      setMessage(error instanceof Error && !["TypeError", "TimeoutError", "SyntaxError"].includes(error.name) ? error.message : "Could not confirm the update. Checking the latest counter state; no automatic retry will be sent.");
    } finally {
      await refresh?.(); busy.current = false; setPending(false);
    }
  }
  return <section className="space-y-3" aria-label="Counters and queues">
    <div><h2 className="text-lg">Counters &amp; Queues</h2><p className="muted text-xs">Current location · Shared queues across active counters</p></div>
    {manage && <nav className="flex gap-2" aria-label="Counter views"><button className="btn" type="button" aria-pressed={!archivedView} onClick={() => setArchivedView(false)}>Active</button><button className="btn" type="button" aria-pressed={archivedView} onClick={() => setArchivedView(true)}>Archived</button></nav>}
    {manage && !archivedView && !parentArchived && <details className="rounded-xl border bg-white p-3"><summary className="cursor-pointer font-semibold text-teal-800">Create counter</summary>
      <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void act("create", undefined, String(new FormData(form).get("name") ?? ""), form); }}>
        <label className="min-w-0 flex-1">Counter name<input className="field" name="name" required maxLength={80} placeholder="Counter 1" disabled={pending} /></label><button className="btn btn-primary" disabled={pending}>Create counter</button>
      </form>
    </details>}
    {message && <p role="alert">{message}</p>}
    {!data ? <p className="empty-state">Counter information is temporarily unavailable.</p> : <>
      {!visibleCounters.length && <p className="empty-state">No counters in this view.</p>}
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{visibleCounters.map((counter) => <li key={counter.id} className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3>{counter.name}</h3><span className={`badge ${counter.active && !counter.sessionId ? "badge-active" : "badge-inactive"}`}>{counter.archived ? "Archived" : !counter.active ? "Disabled" : counter.ticketNumber ? "Serving" : counter.sessionId ? "Occupied" : "Available"}</span></div>
        {counter.sessionId && <div><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{counter.staffName}</p><CounterPresence lastSeenAt={counter.lastSeenAt} observedAt={data.observedAt} /></div><p className="text-sm text-slate-600">{counter.serviceName}</p>{counter.ticketNumber && <p className="mt-2 text-2xl font-semibold text-teal-900">{counter.ticketNumber}</p>}{counter.ticketStartedAt && <div className="mt-2 space-y-1"><p className="text-sm font-medium text-teal-900"><ElapsedTime since={counter.ticketStartedAt} serving /></p><p className="text-xs text-slate-500">Called <time dateTime={counter.ticketStartedAt}>{locationTime(counter.ticketStartedAt, data.locationTimezone)}</time></p></div>}{!counter.operational && <p className="mt-1 text-xs text-amber-800">Session inactive · release when the ticket is resolved</p>}</div>}
        {manage && !counter.archived && !parentArchived && <div className="space-y-2 border-t pt-3">
          <details><summary className="cursor-pointer text-sm font-medium text-teal-800">Edit name</summary><form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; void act("rename", counter.id, String(new FormData(form).get("name") ?? ""), form); }}>
            <label>Counter name<input name="name" className="field" defaultValue={counter.name} required maxLength={80} disabled={pending} /></label><button className="btn" disabled={pending}>Save name</button>
          </form></details>
          <div className="flex flex-wrap gap-2"><button className="btn" type="button" disabled={pending || (counter.active && Boolean(counter.sessionId))} onClick={() => void act(counter.active ? "disable" : "enable", counter.id)}>{counter.active ? "Disable" : "Enable"}</button>
          </div>
        </div>}
        {(manage || recover) && counter.sessionId && !counter.archived && !parentArchived && <div className="space-y-2 border-t pt-3"><div className="flex flex-wrap gap-2">
          <button className="btn btn-danger" type="button" disabled={pending || Boolean(counter.ticketNumber)} onClick={() => void act("release", counter.id)}>Force-release</button>
          {counter.ticketId && <button className="btn btn-danger" type="button" disabled={pending} onClick={() => void act("skip-release", counter.id)}>Skip ticket &amp; release counter</button>}
        </div>{counter.ticketNumber && <p className="text-xs text-slate-500">Serving work is preserved even when disconnected. Complete the ticket, or explicitly confirm Skip ticket &amp; release counter.</p>}</div>}
        {manage && <LifecycleActions kind="counters" id={counter.id} name={counter.name} archived={counter.archived} onChanged={refresh} disabled={pending} />}
      </li>)}</ul>
      {!archivedView && <section className="space-y-2" aria-label="Serving ticket details"><h3>Currently serving ({data.servingTickets.length})</h3>
        {!data.servingTickets.length ? <p className="muted">No serving tickets at this location.</p> : <div className="table-card"><table className="responsive-table">
          <caption className="sr-only">Exact serving tickets behind this location’s currently-serving count</caption>
          <thead><tr><th scope="col">Ticket</th><th scope="col">Counter</th><th scope="col">Staff</th><th scope="col">Service</th><th scope="col">Called</th><th scope="col">Recovery</th></tr></thead>
          <tbody>{data.servingTickets.map((ticket) => <tr key={ticket.id}><th scope="row" data-label="Ticket" title={`Ticket ID: ${ticket.id}`}>{ticket.number}</th><td data-label="Counter">{ticket.counterName ?? "No counter recorded (legacy ticket)"}{ticket.needsRecovery && <p className="mt-2"><span className="badge badge-inactive">Stuck / legacy ticket</span></p>}</td><td data-label="Staff">{ticket.staffName}</td><td data-label="Service">{ticket.serviceName}</td><td data-label="Called"><time dateTime={ticket.startedAt}>{locationTime(ticket.startedAt, data.locationTimezone)}</time>{!ticket.counterName && <p><ElapsedTime since={ticket.startedAt} serving /></p>}</td><td data-label="Recovery">{ticket.needsRecovery && (manage || recover) ? <ResolveTicket locationId={locationId} ticket={ticket} disabled={pending} refresh={refresh} /> : "Active counter session"}</td></tr>)}</tbody>
        </table></div>}
      </section>}
      {visibleServices.length > 0 && <div className="table-card"><table className="responsive-table"><caption className="sr-only">Current service capacity and queues at the selected location</caption>
        <thead><tr><th scope="col">Service</th><th scope="col">Active counters</th><th scope="col">Waiting</th><th scope="col">Serving</th><th scope="col">Served today</th></tr></thead>
        <tbody>{visibleServices.map((service) => <tr key={service.id}><th scope="row" data-label="Service">{service.name}{!service.active && <span className="ml-2"><StatusBadge active={false} /></span>}</th><td data-label="Active counters">{service.activeCounters}</td><td data-label="Waiting">{service.waiting}</td><td data-label="Serving">{service.serving}</td><td data-label="Served today">{service.servedToday}</td></tr>)}</tbody>
      </table></div>}
    </>}
  </section>;
}
