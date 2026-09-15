"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQueueUpdates } from "@/lib/realtime/use-queue-updates";
import type { PublicTicket } from "@/lib/customer/types";
import { Icon } from "@/components/ui/icon";
import { estimatedWaitLabel } from "@/lib/customer/estimate";
import { locationTime } from "@/lib/shared/location-time";
import { retryStorageKey } from "@/lib/customer/retry";

const labels = { WAITING: "Waiting", SERVING: "Now serving", COMPLETED: "Completed", SKIPPED: "Skipped", CANCELLED: "Cancelled" };
const terminal = (ticket: PublicTicket) => ["COMPLETED", "SKIPPED", "CANCELLED"].includes(ticket.status);

export function TicketStatus({ token, initial }: { token: string; initial: PublicTicket }) {
  const [ticket, setTicket] = useState(initial);
  const [message, setMessage] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const mutation = useRef<AbortController | null>(null);
  const activeRead = useRef<AbortController | null>(null);
  useEffect(() => () => { activeRead.current?.abort(); mutation.current?.abort(); }, []);
  const refresh = useCallback(async () => {
      if (mutation.current) return 1000;
      const controller = new AbortController(); activeRead.current?.abort(); activeRead.current = controller;
      let nextDelay = 10000;
      try {
        const response = await fetch(`/api/public/tickets/${token}`, {
          cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
        if (controller.signal.aborted) return;
        if (response.status === 404) { setMessage("Ticket not found. Automatic updates have stopped."); return false; }
        if (response.status === 429) nextDelay = Math.max(10000, Number(response.headers.get("retry-after") ?? "60") * 1000);
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!controller.signal.aborted) { setTicket(data.ticket); setMessage(""); if (terminal(data.ticket)) return false; }
      } catch {
        if (!controller.signal.aborted) { setMessage("Updates are delayed. Keep this page open—we’ll try again automatically."); nextDelay = Math.max(nextDelay, 30000); }
      }
      return nextDelay;
  }, [token]);
  useQueueUpdates(`/api/public/tickets/${token}/events`, refresh, 10000, !terminal(ticket));

  async function cancel() {
    if (mutation.current || ticket.status !== "WAITING") return;
    if (!window.confirm(`Leave the queue and cancel ${ticket.queueNumber}? You will lose your place. Joining again gives you a new ticket.`)) return;
    const controller = new AbortController(); mutation.current = controller;
    activeRead.current?.abort();
    setCancelling(true); setCancelError("");
    let succeeded = false;
    try {
      const response = await fetch(`/api/public/tickets/${token}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) {
        const retry = response.status === 429 ? ` Try again after ${response.headers.get("retry-after") ?? "900"} seconds.` : "";
        throw new Error((data.error ?? "Unable to leave the queue. Please try again.") + retry);
      }
      setTicket(data.ticket); setMessage(""); succeeded = true;
    } catch (error) {
      if (!controller.signal.aborted) setCancelError(error instanceof Error && !["TypeError", "TimeoutError", "AbortError", "SyntaxError"].includes(error.name)
        ? error.message : "We couldn’t confirm the cancellation. Checking your latest ticket status; no cancellation will be retried automatically.");
    } finally {
      if (mutation.current === controller) mutation.current = null;
      if (!controller.signal.aborted) {
        // Read authoritative state after conflicts or uncertain network outcomes.
        if (!succeeded) await refresh();
        setCancelling(false);
      }
    }
  }

  const timestamps = [["Joined", ticket.joinedAt], ["Called", ticket.calledAt], ["Completed", ticket.completedAt], ["Skipped", ticket.skippedAt], ["Cancelled", ticket.cancelledAt]];
  const estimate = estimatedWaitLabel(ticket.estimatedWaitMinutes);
  const callTime = ticket.estimatedCallAt ? locationTime(ticket.estimatedCallAt, ticket.locationTimezone).split(" · ")[1] : undefined;
  return <section className="customer-ticket space-y-4">
    <header className="customer-ticket-hero" data-status={ticket.status}>
      <p className="eyebrow flex items-center justify-center gap-2"><Icon name="ticket" />Your queue number</p>
      <h1 className="customer-queue-number">{ticket.queueNumber}</h1>
      <div className="customer-ticket-status" aria-live="polite" aria-atomic="true">
        <span className="customer-status-label"><Icon name={ticket.status === "WAITING" ? "clock" : ["SKIPPED", "CANCELLED"].includes(ticket.status) ? "pause" : "check"} />{labels[ticket.status]}</span>
        <h2 className="mt-4 text-2xl font-bold sm:text-3xl">{ticket.status === "SERVING" ? "It’s your turn" : ticket.status === "WAITING" ? "You’re in the queue" : ticket.status === "COMPLETED" ? "All done. Thank you!" : ticket.status === "CANCELLED" ? "You’ve left the queue" : "Your ticket was skipped"}</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed">{ticket.status === "WAITING" ? "Thanks for waiting. We’ll keep this page updated." : ticket.status === "SERVING" ? "Please go to your service and show this number to staff." : ticket.status === "COMPLETED" ? "Your visit is complete." : ticket.status === "CANCELLED" ? "Your ticket is cancelled. You can join again for a new place in the queue." : "Please speak with staff if you still need help."}</p>
      </div>
      {ticket.status === "SERVING" && ticket.counterName && <p className="my-5 rounded-2xl bg-blue-900 px-4 py-5 text-2xl font-bold text-white sm:text-3xl">Please go to {ticket.counterName}</p>}
      <div className="customer-ticket-service"><span className="text-xs font-medium uppercase tracking-wider text-slate-500">Your service</span><p className="mt-1 text-lg font-semibold text-slate-900">{ticket.service}</p><p className="mt-1 flex items-center justify-center gap-1.5 text-sm text-slate-600"><Icon name="location" className="size-4" />{ticket.location}</p></div>
    </header>
    {ticket.status === "WAITING" && <div className="space-y-3" aria-live="polite" aria-atomic="true">
      {estimate && <div className="wait-estimate customer-wait-estimate"><p className="flex items-center justify-center gap-2 text-sm font-medium"><Icon name="clock" />Estimated wait</p><p className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">{estimate}</p><p className="mt-3 text-xs leading-relaxed text-emerald-50">{ticket.peopleAhead === 0 ? "No one is waiting ahead of you. Staff may still be helping someone." : "An estimate, not a fixed time. We’ll update it as the queue moves."}</p></div>}
      {ticket.estimatedCallAt && callTime && estimate && <div className="rounded-2xl border border-teal-200 bg-white p-4 text-center"><p className="text-sm font-medium text-slate-600">Likely call time</p><p className="mt-1 text-2xl font-semibold text-teal-900">Around <time dateTime={ticket.estimatedCallAt} title={locationTime(ticket.estimatedCallAt, ticket.locationTimezone)}>{callTime}</time></p><p className="mt-1 text-xs text-slate-500">An estimate in the location’s local time. It may change as counters and queues move.</p></div>}
      {!estimate && <p className="rounded-xl border bg-white p-4 text-sm text-slate-600">An estimated wait isn’t available right now. We’ll update it when serving capacity is available.</p>}
      <div className="customer-ahead-card"><div className="flex items-center gap-3"><span className="rounded-xl bg-teal-50 p-2.5 text-teal-800"><Icon name="people" className="size-6" /></span><p className="font-medium text-slate-700">People ahead</p></div><p className="text-4xl font-bold tabular-nums text-teal-950">{ticket.peopleAhead ?? "—"}</p></div>
    </div>}
    <section className="card customer-visit-details" aria-label="Visit details"><h2 className="text-base font-semibold">Visit details</h2><p className="mt-1 text-xs text-slate-500">Times shown in this location’s local time</p>
      <dl className="mt-3 divide-y divide-slate-100">{timestamps.map(([label, value]) => value && <div key={label} className="flex flex-wrap justify-between gap-x-3 gap-y-1 py-3 last:pb-0"><dt className="text-sm font-medium text-slate-600">{label}</dt><dd className="text-sm font-medium text-slate-800"><time dateTime={value} title={ticket.locationTimezone}>{locationTime(value, ticket.locationTimezone)}</time></dd></div>)}</dl>
    </section>
    {ticket.status === "WAITING" && <button type="button" className="btn btn-danger w-full" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "Leaving queue…" : "Leave queue"}</button>}
    {ticket.status === "CANCELLED" && <Link className="btn btn-primary w-full" href={`/q/${ticket.locationSlug}`} onClick={() => {
      // An explicit new visit must not reuse the cancelled join's retry receipt.
      try { sessionStorage.removeItem(retryStorageKey(ticket.locationSlug)); } catch {}
    }}>Return to services / Join again<Icon name="arrow" /></Link>}
    {cancelling && <p role="status">Checking your cancellation…</p>}
    {cancelError && ticket.status !== "CANCELLED" && <p role="alert">{cancelError}</p>}
    {message && <p role="alert">{message}</p>}
    {!terminal(ticket) && <p className="text-center text-xs text-slate-500">Keep this page open. No need to refresh.</p>}
    <p className="status-note"><Icon name="shield" className="size-4" />Keep your ticket link private. Anyone with the link can view your ticket and cancel it while waiting.</p>
  </section>;
}
