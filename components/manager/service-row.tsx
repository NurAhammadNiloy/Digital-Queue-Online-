"use client";
import { LifecycleActions } from "@/components/manager/lifecycle-actions";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ServiceView } from "@/lib/manager/types";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConfigPanel } from "@/components/manager/config-panel";

export function ServiceRow({ service, locationId }: { service: ServiceView; locationId: string }) {
  const router = useRouter(), busy = useRef(false);
  const [pending, setPending] = useState(false), [message, setMessage] = useState("");
  const [editingPending, setEditingPending] = useState(false);
  async function toggle() {
    if (busy.current || editingPending || !window.confirm(`${service.active ? "Deactivate" : "Activate"} “${service.name}”? ${service.active ? "New joins and staff actions for this service will be blocked. History is preserved." : "Assigned staff and customers can use this service when its location is active."}`)) return;
    busy.current = true; setPending(true); setMessage("");
    try {
      // Re-read through the existing scoped API before its existing full update
      // contract, so an old rendered row does not overwrite known newer details.
      const current = await fetch(`/api/manager/locations/${locationId}`, { cache: "no-store" });
      const snapshot = await current.json();
      if (!current.ok) throw new Error(snapshot.error ?? "Unable to read service.");
      const value: ServiceView | undefined = snapshot.services.find((item: ServiceView) => item.id === service.id);
      if (!value) throw new Error("Service unavailable. Refresh this page.");
      const response = await fetch(`/api/manager/locations/${locationId}/services/${service.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ name: value.name, queuePrefix: value.queue_prefix, defaultServiceMinutes: value.default_service_minutes, active: !service.active }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to update service.");
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to update service. Refresh and try again."); }
    finally { busy.current = false; setPending(false); }
  }
  return <li className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h3>{service.name}</h3><p className="mt-1 text-sm text-slate-600">{service.queue_prefix} · {service.default_service_minutes} min</p></div>{service.archived_at ? <span className="badge badge-inactive">Archived</span> : <StatusBadge active={service.active} />}</div>
    {!service.archived_at && <fieldset disabled={pending} className="flex flex-wrap items-start gap-2"><ConfigPanel key={JSON.stringify(service)} kind="service" locationId={locationId} service={service} label="Edit" onBusyChange={setEditingPending} /><button type="button" className="btn" disabled={editingPending} onClick={() => void toggle()}>{pending ? "Updating…" : service.active ? "Deactivate" : "Activate"}</button></fieldset>}
    <div className="mt-3"><LifecycleActions kind="services" id={service.id} name={service.name} archived={Boolean(service.archived_at)} disabled={pending || editingPending} /></div>
    {message && <p role="alert" className="mt-3">{message}</p>}
  </li>;
}
