"use client";
import { useId, useRef, useState } from "react";
import type { CounterOperations } from "@/lib/counters/types";

export function ResolveTicket({ locationId, ticket, disabled = false, refresh }: {
  locationId: string; ticket: CounterOperations["servingTickets"][number]; disabled?: boolean; refresh?: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [message, setMessage] = useState("");
  const [action, setAction] = useState<"skip" | "complete">("skip");
  const busy = useRef(false), trigger = useRef<HTMLButtonElement>(null), id = useId();
  function close() { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }
  async function resolve() {
    if (busy.current || disabled) return;
    const question = action === "skip"
      ? `Mark ${ticket.number} (${ticket.serviceName}) skipped and close it? The ticket and its original attribution remain in history. It will not count as completed. This cannot be undone.`
      : `Mark ${ticket.number} (${ticket.serviceName}) completed now? Only confirm if the service was actually completed. Its original start time and staff attribution will be used in completed analytics. This cannot be undone.`;
    if (!window.confirm(question)) return;
    busy.current = true; setPending(true); setMessage("");
    try {
      const response = await fetch(`/api/manager/locations/${locationId}/tickets/${ticket.id}/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
        cache: "no-store", signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to resolve this ticket. Refresh and try again.");
      close();
    } catch (error) {
      setMessage(error instanceof Error && !["TypeError", "TimeoutError", "SyntaxError", "AbortError"].includes(error.name)
        ? error.message : "The result could not be confirmed. Check the refreshed ticket state before trying again; no automatic retry was sent.");
    } finally {
      try { await refresh?.(); }
      finally { busy.current = false; setPending(false); }
    }
  }
  return <div className="space-y-2">
    <button ref={trigger} type="button" className="btn" aria-expanded={open} aria-controls={id} disabled={pending || disabled} onClick={() => { setAction("skip"); setMessage(""); setOpen(true); }}>Resolve</button>
    {open && <form id={id} className="min-w-0 space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-3" onSubmit={(event) => { event.preventDefault(); void resolve(); }}>
      <fieldset className="space-y-3" disabled={pending || disabled}>
        <legend className="mb-2 text-sm font-semibold">Resolve {ticket.number}</legend>
        <label className="block text-sm">Outcome<select className="field" value={action} onChange={(event) => setAction(event.target.value === "complete" ? "complete" : "skip")}>
          <option value="skip">Mark skipped &amp; close (recommended)</option><option value="complete">Mark completed</option>
        </select></label>
        <p className="text-xs text-slate-600">Skip if completion is uncertain. No ticket will be deleted.</p>
        <div className="flex flex-wrap gap-2"><button type="submit" className="btn btn-danger">{pending ? "Resolving…" : action === "skip" ? "Mark skipped & close" : "Mark completed"}</button><button type="button" className="btn" onClick={close}>Cancel</button></div>
      </fieldset>
    </form>}
    {message && <p role="alert" className="text-sm">{message}</p>}
  </div>;
}
