"use client";

import { LifecycleActions } from "./lifecycle-actions";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LocationView } from "@/lib/manager/types";

export function LocationActions({ location }: { location: LocationView }) {
  const router = useRouter(), busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  async function act(action: "activate" | "deactivate") {
    if (busy.current) return;
    const question = action === "deactivate"
        ? `Deactivate “${location.name}”? New joins and all staff queue actions will be blocked. Tickets and history will be preserved.`
        : `Activate “${location.name}”? Customers can join active services and assigned staff can resume queue operations.`;
    if (!window.confirm(question)) return;
    busy.current = true; setPending(true); setMessage(""); setFailed(false);
    try {
      const response = await fetch(`/api/manager/locations/${location.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }), cache: "no-store", signal: AbortSignal.timeout(15000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to update location.");
      setMessage(action === "activate" ? "Location activated." : "Location deactivated. Tickets and history preserved.");
      router.refresh();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error && !["TypeError", "TimeoutError"].includes(error.name) ? error.message : "The result could not be confirmed. Refresh the location before trying again.");
      router.refresh();
    } finally { busy.current = false; setPending(false); }
  }
  return <section className="space-y-3 border-t border-slate-200 pt-5" aria-label="Location lifecycle" aria-busy={pending}>
    <div className="flex flex-wrap gap-3">
      {!location.archived_at && <button type="button" className="btn" disabled={pending} onClick={() => void act(location.active ? "deactivate" : "activate")}>{location.active ? "Deactivate location" : "Activate location"}</button>}
      <LifecycleActions kind="locations" id={location.id} name={location.name} archived={Boolean(location.archived_at)} returnTo="/manager/locations" disabled={pending} />
    </div>
    <p className="muted">Delete archives locations with history or dependencies. Restore leaves the location and its archived services/counters inactive; restore children separately.</p>
    {pending && <p role="status">Updating location…</p>}
    {message && <p role={failed ? "alert" : "status"}>{message}</p>}
  </section>;
}
