"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { LocationView, ServiceView } from "@/lib/manager/types";
import { TimezoneSelect } from "@/components/manager/timezone-select";

export type ConfigFormProps = { kind: "location"; location?: LocationView } | { kind: "service"; locationId: string; service?: ServiceView };
const input = "field";
export function ConfigForm(props: ConfigFormProps & { onSaved?: () => void; onPending?: (pending: boolean) => void }) {
  const router = useRouter(), busy = useRef(false);
  const [pending, setPending] = useState(false), [message, setMessage] = useState(""), [failed, setFailed] = useState(false);
  const existing = props.kind === "location" ? props.location : props.service;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const form = event.currentTarget, fields = new FormData(form);
    const body = { name: fields.get("name"), ...(props.kind === "location" && existing ? {} : { active: fields.get("active") === "on" }), ...(props.kind === "location"
      ? { description: fields.get("description"), address: fields.get("address"), timezone: fields.get("timezone") }
      : { queuePrefix: fields.get("queuePrefix"), defaultServiceMinutes: Number(fields.get("defaultServiceMinutes")) }) };
    if (props.kind === "service" && props.service?.active && body.active === false && !window.confirm("Deactivate this service? New joins and staff actions will be blocked; history will be preserved.")) return;
    busy.current = true; setPending(true); props.onPending?.(true); setMessage(""); setFailed(false);
    try {
      const base = props.kind === "location" ? "/api/manager/locations" : `/api/manager/locations/${props.locationId}/services`;
      const response = await fetch(`${base}${existing ? `/${existing.id}` : ""}`, { method: existing ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to save changes.");
      if (props.kind === "location" && !existing) router.push(`/manager/locations/${data.id}`);
      else { setMessage("Saved."); if (!existing) form.reset(); }
      router.refresh();
      props.onSaved?.();
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : "Unable to save changes."); }
    finally { busy.current = false; setPending(false); props.onPending?.(false); }
  }
  return <form onSubmit={submit} aria-busy={pending} className="space-y-4 print:hidden">
    <fieldset disabled={pending} className="space-y-5">
      <legend className="mb-4 text-lg font-semibold">{existing ? `Edit ${props.kind}` : `Create ${props.kind}`}</legend>
      <label className="block">Name<input name="name" className={input} required maxLength={200} defaultValue={existing?.name} /></label>
      {props.kind === "location" ? <>
        <label className="block">Description<textarea name="description" className={input} maxLength={2000} defaultValue={props.location?.description ?? ""} /></label>
        <label className="block">Address (optional)<input name="address" className={input} maxLength={500} defaultValue={props.location?.address ?? ""} /></label>
        <TimezoneSelect initial={props.location?.timezone} />
      </> : <>
        <label className="block">Queue prefix<input name="queuePrefix" className={input} required maxLength={4} pattern="[A-Za-z]{1,4}" autoCapitalize="characters" defaultValue={props.service?.queue_prefix} /><span className="text-sm">1–4 letters. Existing tickets keep their original prefix.</span></label>
        <label className="block">Default service minutes<input name="defaultServiceMinutes" type="number" className={input} required min={1} max={2147483647} step={1} defaultValue={props.service?.default_service_minutes ?? 5} /></label>
      </>}
      {!(props.kind === "location" && existing) && <label className="flex items-center gap-2"><input name="active" type="checkbox" defaultChecked={existing?.active ?? true} />Active</label>}
      <button type="submit" className="btn btn-primary">{pending ? "Saving…" : existing ? "Save changes" : `Create ${props.kind}`}</button>
    </fieldset>
    <p role={failed ? "alert" : "status"}>{message}</p>
  </form>;
}
