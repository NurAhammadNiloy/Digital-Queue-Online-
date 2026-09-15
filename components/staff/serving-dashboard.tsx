"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { StaffQueueState } from "@/lib/staff/serving-types";
import { staffResponseError } from "@/lib/staff/action-error";
import { useQueueUpdates } from "@/lib/realtime/use-queue-updates";
import { Avatar, Icon } from "@/components/ui/icon";
import { locationTime } from "@/lib/shared/location-time";
import { ElapsedTime } from "@/components/staff/elapsed-time";
import { useStaffPresence } from "@/lib/counters/use-staff-presence";
import { CounterControls } from "@/components/staff/counter-controls";

const button = "btn min-h-12 px-5 py-3";
type Action = "call-next" | "complete" | "skip" | "logout" | "start-counter" | "end-counter";

export function ServingDashboard({ initial }: { initial: StaffQueueState }) {
  const router = useRouter();

  const [state, setState] = useState<StaffQueueState | null>(initial);
  const latest = useRef<StaffQueueState | null>(initial);
  useStaffPresence(state?.counterSession?.id ?? null);
  const [pending, setPending] = useState<Action | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(true);
  const [message, setMessage] = useState("");
  const [actionFailed, setActionFailed] = useState(false);
  const [readError, setReadError] = useState("");
  const busy = useRef(false);
  const mounted = useRef(true);
  const signedOut = useRef(false);
  const read = useRef<AbortController | null>(null);
  const generation = useRef(0);

  const leave = useCallback(() => {
    signedOut.current = true; latest.current = null; setState(null); setReady(false);
    router.replace("/staff/login"); router.refresh();
  }, [router]);

  const refresh = useCallback(async (serviceId?: string | null, page = 1, background = false) => {
    if (signedOut.current) return;
    if (background && (busy.current || read.current)) return;
    read.current?.abort();
    const controller = new AbortController(); read.current = controller;
    const version = ++generation.current;
    // Background reads retain both the rendered queue and usable controls.
    // Explicit navigation/actions still lock controls until their read finishes.
    if (!background) { setLoading(true); setReady(false); }
    const params = new URLSearchParams({ page: String(page) });
    if (serviceId) params.set("serviceId", serviceId);
    const options = { cache: "no-store" as const, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) };
    try {
      let response = await fetch(`/api/staff/queue?${params}`, options);
      // Permissions may have changed since the previous poll. Reload only the
      // server's current allowed selection rather than retaining revoked rows.
      if (!mounted.current || controller.signal.aborted || version !== generation.current) return;
      if (response.status === 403) {
        // Explicit access loss must remove revoked records, even if the
        // subsequent read fails. Transient/network failures retain known data.
        latest.current = null; setState(null); setReady(false);
        if (serviceId) response = await fetch("/api/staff/queue", options);
      }
      if (!mounted.current || controller.signal.aborted || version !== generation.current) return;
      if (staffResponseError(response.status).expired) { leave(); return; }
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(staffResponseError(response.status, error.error).message);
      }
      const data: StaffQueueState = await response.json();
      if (!mounted.current || controller.signal.aborted || version !== generation.current) return;
      latest.current = data;
      setState((previous) => JSON.stringify(previous) === JSON.stringify(data) ? previous : data);
      setReady(true); setReadError("");
    } catch (error) {
      if (mounted.current && version === generation.current && !controller.signal.aborted) {
        setReady(false);
        setReadError(error instanceof Error && !["TypeError", "TimeoutError", "AbortError"].includes(error.name) ? error.message : "Queue updates are unavailable. Refresh successfully before taking another action.");
      }
    } finally {
      if (mounted.current && version === generation.current) { read.current = null; setLoading(false); }
    }
  }, [leave]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; read.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!message || actionFailed) return;
    const timer = setTimeout(() => setMessage(""), 5000);
    return () => clearTimeout(timer);
  }, [message, actionFailed]);
  const liveRefresh = useCallback(async () => {
    if (signedOut.current) return false;
    if (busy.current || read.current) return 1000;
    await refresh(latest.current?.selectedServiceId, latest.current?.page, true);
  }, [refresh]);
  useQueueUpdates(state?.selectedServiceId ? `/api/staff/events?serviceId=${state.selectedServiceId}` : null, liveRefresh, 5000);

  async function act(action: Action, counterId?: string) {
    if (busy.current || (action !== "logout" && (!ready || loading || !latest.current))) return;
    const current = latest.current;
    const assignment = current?.assignments.find((a) => a.serviceId === current.selectedServiceId);
    if (action === "call-next" && (!current?.counterSession?.operational || current.counterSession.serviceId !== current.selectedServiceId)) return;
    if (["start-counter", "end-counter"].includes(action) && (current?.serving || current?.servingAccessBlocked)) return;
    if (action === "start-counter" && (!assignment || current?.counterSession || !current?.availableCounters.some((c) => c.id === counterId))) return;
    if (action === "call-next" && (!current?.selectedServiceId || !current.waitingTotal || current.serving || current.servingAccessBlocked)) return;
    if (["complete", "skip"].includes(action) && !current?.serving) return;
    if (action === "skip" && !window.confirm(`Skip ${current!.serving!.queueNumber} (${current!.serving!.customerName})? This will mark the ticket as skipped.`)) return;
    busy.current = true; setPending(action); setReady(false); setMessage(""); setActionFailed(false);
    read.current?.abort(); read.current = null; generation.current++;
    try {
      const counterAction = action === "start-counter" || action === "end-counter";
      const response = await fetch(action === "logout" ? "/api/auth/logout?role=staff" : counterAction ? "/api/staff/counter" : `/api/staff/queue/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify(action === "logout" ? {} : action === "start-counter" ? { action: "start", counterId, locationId: assignment!.locationId, serviceId: assignment!.serviceId } : action === "end-counter" ? { action: "end" } : action === "call-next" ? { serviceId: current!.selectedServiceId } : { ticketId: current!.serving!.id }),
        signal: AbortSignal.timeout(15000),
      });
      if (!mounted.current) return;
      if (staffResponseError(response.status).expired) { leave(); return; }
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(staffResponseError(response.status, error.error).message);
      }
      const result = await response.json();
      if (action === "logout") { leave(); return; }
      setMessage(action === "start-counter" ? "Counter session started." : action === "end-counter" ? "Counter released." : action === "call-next" ? result.ticket ? `Called ${result.ticket.queueNumber}.` : "No waiting customers for this service." : action === "complete" ? "Ticket completed." : "Ticket skipped.");
    } catch (error) {
      if (mounted.current) setActionFailed(true);
      if (mounted.current) setMessage(error instanceof Error && error.name !== "TypeError" && error.name !== "TimeoutError" ? error.message : "The action result could not be confirmed. Checking current queue state; no automatic action retry will be sent.");
    } finally {
      // Always read authoritative state, including on conflicts/uncertain results.
      // Old polling responses cannot overwrite the result of this refresh.
      if (mounted.current && !signedOut.current) await refresh(current?.selectedServiceId, 1);
      busy.current = false;
      if (mounted.current) setPending(null);
    }
  }

  const disabled = Boolean(pending) || loading || !ready;
  const servingAssignment = state?.assignments.find((a) => a.serviceId === state.serving?.serviceId);
  const selectedAssignment = state?.assignments.find((a) => a.serviceId === state.selectedServiceId);
  return <main className="page">
    <header className="workspace-header">
      <div className="space-y-2"><p className="eyebrow">Digital Queue · Staff workspace</p><h1>Staff serving dashboard</h1><p className="muted">Signed in as {state?.staffName ?? "staff"}.</p></div>
      <div className="flex flex-wrap items-center gap-3"><button type="button" className="btn-link text-sm" disabled={Boolean(pending) || loading} onClick={() => void refresh(state?.selectedServiceId, state?.page)}>{loading ? "Refreshing…" : "Refresh"}</button><Avatar name={state?.staffName ?? "Staff"} /><button type="button" className={button} disabled={Boolean(pending)} onClick={() => void act("logout")}><Icon name="logout" />{pending === "logout" ? "Logging out…" : "Log out"}</button></div>
    </header>
    {message && <div className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-lg items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-lg"><p role={actionFailed ? "alert" : "status"}>{message}</p><button type="button" className="btn shrink-0" aria-label="Dismiss action message" onClick={() => setMessage("")}>Dismiss</button></div>}
    {readError && <p role="alert">{readError}</p>}
    {state && <>
      <CounterControls state={state} disabled={disabled} pending={pending} selectService={(id) => void refresh(id, 1)} start={(id) => void act("start-counter", id)} end={() => void act("end-counter")} />
      {!state.assignments.length && <p>No active service is assigned to you. Ask your manager to check your assignment.</p>}
      <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
        <section className="card serving-panel space-y-5" aria-busy={Boolean(pending)}>
          <h2 className="flex items-center gap-2 text-xl font-semibold"><Icon name="ticket" />Currently serving</h2>
          {state.serving ? <>
            <p className="text-5xl font-bold tracking-tight text-teal-900">{state.serving.queueNumber}</p><p className="flex items-center gap-3 text-lg font-medium"><Avatar name={state.serving.customerName} />{state.serving.customerName}</p>
            <p className="muted">{servingAssignment?.locationName} / {servingAssignment?.serviceName}</p>
            {state.serving.counterName && <p className="font-semibold text-teal-900">{state.serving.counterName}</p>}
            {state.serving.startedAt && <p className="rounded-xl border border-teal-200 bg-white/75 px-3 py-3 text-base font-semibold text-teal-900"><ElapsedTime since={state.serving.startedAt} serving /></p>}
            <dl className="space-y-2 text-sm">{[["Joined", state.serving.joinedAt], ["Called", state.serving.startedAt]].map(([label, value]) => value && <div key={label}><dt className="font-medium">{label}</dt><dd><time dateTime={value} title={servingAssignment?.locationTimezone}>{locationTime(value, servingAssignment?.locationTimezone)}</time></dd></div>)}</dl>
            <div className="flex flex-wrap gap-3">
              <button type="button" className={`${button} btn-primary grow`} disabled={disabled} onClick={() => void act("complete")}><Icon name="check" />COMPLETE</button>
              <button type="button" className={`${button} btn-danger grow`} disabled={disabled} onClick={() => void act("skip")}>SKIP</button>
            </div>
          </> : <p className="empty-state">{state.servingAccessBlocked ? "You have a serving ticket whose service permission is no longer active. Ask your manager to restore access before continuing." : "You are not serving a ticket."}</p>}
          <button type="button" className={`${button} btn-primary w-full`} disabled={disabled || !state.selectedServiceId || !state.waitingTotal || Boolean(state.serving) || state.servingAccessBlocked || !state.counterSession?.operational || state.counterSession.serviceId !== state.selectedServiceId}
            onClick={() => void act("call-next")}>{state.serving || state.servingAccessBlocked ? "Finish current ticket first" : !state.counterSession?.operational ? "Start a counter first" : <>CALL NEXT<Icon name="arrow" /></>}</button>
          {pending && pending !== "logout" && <p role="status">Applying action and refreshing…</p>}
        </section>
        <section className="card space-y-4">
          <h2 className="text-xl font-semibold">Waiting queue ({state.waitingTotal})</h2>
          {!state.waiting.length ? <p className="empty-state">{state.waitingTotal ? "No tickets on this page. Return to the previous page or refresh." : "No waiting customers."}</p> :
            <div className="table-card"><table className="responsive-table">
              <caption className="sr-only">Waiting customers in queue order</caption>
              <thead><tr><th scope="col">Number</th><th scope="col">Customer</th><th scope="col">Waiting</th></tr></thead>
              <tbody>{state.waiting.map((ticket, index) => <tr key={ticket.id}><th scope="row" data-label="Number" className="text-base font-semibold text-teal-900"><span className="flex flex-wrap items-center gap-2">{ticket.queueNumber}{state.page === 1 && index === 0 && <span className="badge badge-active text-xs">Next</span>}</span></th><td data-label="Customer">{ticket.customerName}</td><td data-label="Waiting"><p className="text-sm font-medium text-slate-800"><ElapsedTime since={ticket.joinedAt} /></p><p className="mt-1 text-xs text-slate-500">Joined <time dateTime={ticket.joinedAt} title={selectedAssignment?.locationTimezone}>{locationTime(ticket.joinedAt, selectedAssignment?.locationTimezone)}</time></p></td></tr>)}</tbody>
            </table></div>}
          {state.waitingTotal > state.pageSize && <nav aria-label="Waiting queue pages" className="flex flex-wrap items-center gap-3">
            <button type="button" className={button} disabled={disabled || state.page <= 1} onClick={() => void refresh(state.selectedServiceId, state.page - 1)}>Previous</button>
            <span>Page {state.page}</span>
            <button type="button" className={button} disabled={disabled || state.page * state.pageSize >= state.waitingTotal} onClick={() => void refresh(state.selectedServiceId, state.page + 1)}>Next page</button>
          </nav>}
        </section>
      </div>
    </>}
  </main>;
}
