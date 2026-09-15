"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { canonicalCustomerName, isRandomToken } from "@/lib/customer/input";
import { prepareJoinAttempt, retryStorageKey, type JoinAttempt } from "@/lib/customer/retry";
import type { PublicLocation } from "@/lib/customer/types";
import { Icon } from "@/components/ui/icon";
import { estimatedWaitLabel } from "@/lib/customer/estimate";
import { useQueueUpdates } from "@/lib/realtime/use-queue-updates";

export function JoinForm({ location }: { location: PublicLocation }) {
  const busy = useRef(false);
  const confirmedUrl = useRef<string | null>(null);
  const attempt = useRef<JoinAttempt | undefined>(undefined);
  const submitted = useRef<{ name: string; serviceId: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [current, setCurrent] = useState(location);
  const [unavailable, setUnavailable] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const activeRead = useRef<AbortController | null>(null);
  useEffect(() => () => activeRead.current?.abort(), []);
  const refresh = useCallback(async () => {
    const controller = new AbortController();
    activeRead.current?.abort(); activeRead.current = controller;
    let delay = 10000;
    try {
      const response = await fetch(`/api/public/locations/${location.slug}`, {
        cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (controller.signal.aborted) return;
      if (response.status === 404) { setUnavailable(true); setUpdateError(""); return 10000; }
      if (response.status === 429) delay = Math.max(10000, Number(response.headers.get("retry-after") ?? "60") * 1000);
      if (!response.ok) throw new Error();
      const data: { location: PublicLocation } = await response.json();
      if (controller.signal.aborted) return;
      // Stable radio keys and an uncontrolled name field preserve entered
      // details/focus. Only the authoritative service snapshot changes.
      setCurrent((previous) => JSON.stringify(previous) === JSON.stringify(data.location) ? previous : data.location);
      setUnavailable(false); setUpdateError("");
    } catch {
      if (!controller.signal.aborted) setUpdateError("Updates are delayed. Your details are safe; we’ll try again automatically.");
      delay = Math.max(delay, 30000);
    }
    return delay;
  }, [location.slug]);
  useQueueUpdates(null, refresh, 10000, !receipt);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || confirmedUrl.current || receipt || (!uncertain && (unavailable || !current.services.length))) return;
    busy.current = true; setPending(true); setMessage("");
    const fields = new FormData(event.currentTarget);
    let sent = false;
    try {
      const body = submitted.current ?? {
        name: canonicalCustomerName(String(fields.get("name") ?? "")), serviceId: String(fields.get("serviceId") ?? ""),
      };
      attempt.current = await prepareJoinAttempt(location.slug, body.name, body.serviceId, attempt.current);
      submitted.current = body;
      sent = true;
      const response = await fetch(`/api/public/locations/${location.slug}/tickets`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.current.key },
        body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(15000),
      });
      const data: unknown = await response.json().catch(() => null);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("We couldn’t read the queue response. Choose Check my ticket to recover the same request without joining twice.");
      }
      const result = data as Record<string, unknown>;
      if (!response.ok) {
        // Only a definite validation rejection permits editing the request.
        if ([400, 403, 404, 409, 413].includes(response.status)) { submitted.current = null; sent = false; }
        const wait = response.status === 429 ? ` Retry after ${response.headers.get("retry-after") ?? "900"} seconds.` : "";
        throw new Error((typeof result.error === "string" ? result.error : "Unable to join the queue.") + wait);
      }
      if (typeof result.token !== "string" || !isRandomToken(result.token)) {
        throw new Error("The queue response didn’t include a valid private ticket. Choose Check my ticket to recover the same request without joining twice.");
      }
      // Build a same-origin path from the validated bearer token, never an
      // arbitrary response URL. Ticket details are loaded on the ticket page.
      const url = `/ticket/${result.token}`;
      confirmedUrl.current = url;
      setReceipt(url); setUncertain(false);
      setMessage("You’re in the queue. Opening your ticket… If this page stays open, use Open your private ticket below. Do not join again.");
      // A document navigation avoids depending on an asynchronous RSC/router
      // transition after the ticket has already been created.
      window.location.replace(url);
    } catch (error) {
      setUncertain(sent && !confirmedUrl.current);
      setMessage(confirmedUrl.current
        ? "Your ticket is ready, but automatic navigation failed. Use Open your private ticket below; do not join again."
        : error instanceof Error && !["TimeoutError", "TypeError", "SyntaxError", "AbortError"].includes(error.name)
          ? error.message : "We couldn’t confirm your ticket. Choose Check my ticket to recover the same request without joining twice.");
    } finally { busy.current = false; setPending(false); }
  }

  return <form onSubmit={submit} aria-busy={pending} className="card customer-join-form space-y-5">
    {unavailable && <p role="status">This location isn’t accepting new customers right now.</p>}
    {!unavailable && !current.services.length && <p className="empty-state">No services are available right now.</p>}
    <fieldset disabled={pending || uncertain || Boolean(receipt) || unavailable || !current.services.length} className="space-y-4">
      <legend className="mb-4 text-xl font-semibold">Join a queue</legend>
      <fieldset className="space-y-3" aria-describedby="service-help"><legend className="mb-3 text-sm font-medium">Select a service</legend>
        {current.services.map((service) => <label key={service.id} className="customer-service-choice">
          <input type="radio" name="serviceId" value={service.id} required />
          <span className="service-symbol" aria-hidden="true">{service.code}</span>
          <span className="min-w-0 flex-1"><span className="block break-words text-base font-semibold text-slate-900">{service.name}</span>
            <span className="mt-1 block text-sm font-normal text-slate-600">{service.waitingCount === 0 ? "No one waiting" : `${service.waitingCount} waiting`}</span>
            <span className="mt-1 block min-h-6 text-base font-bold tabular-nums text-teal-900">{service.waitingCount > 0 && service.estimatedWaitMinutes !== null && service.estimatedWaitMinutes > 0 ? estimatedWaitLabel(service.estimatedWaitMinutes) : null}</span>
          </span>
          <span className="service-selection-mark" aria-hidden="true"><Icon name="check" className="size-5" /></span>
        </label>)}
      </fieldset>
      <label className="block pt-2">Your name<input name="name" autoComplete="name" placeholder="Enter your name" required maxLength={200} className="field" /></label>
    </fieldset>
    <button disabled={pending || Boolean(receipt) || (!uncertain && (unavailable || !current.services.length))} className="btn btn-primary min-h-12 w-full" type="submit">{pending ? "Joining…" : uncertain ? "Check my ticket" : "Join queue"}<Icon name="arrow" /></button>
    {message && <p role={receipt ? "status" : "alert"}>{message}</p>}
    {receipt && <p><a className="underline" href={receipt} referrerPolicy="no-referrer">Open your private ticket</a></p>}
    <p id="service-help" className="muted">Wait times are estimates and update automatically.</p>
    {updateError && <p role="status" className="muted">{updateError}</p>}
    {!uncertain && !receipt && <details className="text-sm text-slate-500"><summary className="w-fit cursor-pointer rounded-md py-2 underline underline-offset-4">Already joined today?</summary><p className="mt-2 text-sm">Joining again with the same details opens your existing ticket. Start a separate visit only if you need a new ticket.</p><button type="button" className="btn-link mt-1" disabled={pending} onClick={() => {
      attempt.current = undefined;
      try { sessionStorage.removeItem(retryStorageKey(location.slug)); } catch {}
      setMessage("You can now join for another visit. Only continue if you need a new ticket.");
    }}>Start a separate visit</button></details>}
  </form>;
}
