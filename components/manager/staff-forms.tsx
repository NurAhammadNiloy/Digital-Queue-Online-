"use client";

import { useCallback, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { StaffOptions, StaffView } from "@/lib/staff/types";

import { PinField } from "@/components/manager/pin-field";
import { CreatedCredentials } from "@/components/manager/created-credentials";

const inputClass = "field";
const buttonClass = "btn btn-primary";

async function send(path: string, method: string, body: unknown): Promise<{ id: string }> {
  const response = await fetch(path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Unable to save changes.");
  return data;
}

export function StaffProfileForm({ staff, options }: { staff?: StaffView; options: StaffOptions }) {
  const router = useRouter();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [automaticId, setAutomaticId] = useState(!staff);
  const [selectedServices, setSelectedServices] = useState(() => new Set(staff?.assignments.map((a) => a.serviceId) ?? []));
  const [created, setCreated] = useState<{ id: string; pin: string } | null>(null);
  const clearPin = useCallback(() => setCreated((value) => value ? { ...value, pin: "" } : value), []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || created) return;
    busy.current = true;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setPending(true); setMessage(""); setFailed(false);
    try {
      const selected = new Set(fields.getAll("service"));
      const profile = {
        name: fields.get("name"), staffCode: fields.get("staffCode") ?? "",
        assignments: options.services.filter((s) => selected.has(s.id)).map((s) => ({ locationId: s.locationId, serviceId: s.id })),
        ...(!staff ? { pin: fields.get("pin") } : {}),
      };
      const result = await send(staff ? `/api/manager/staff/${staff.id}` : "/api/manager/staff", staff ? "PUT" : "POST", profile);
      if (!staff) setCreated({ id: result.id, pin: String(fields.get("pin") ?? "") });
      else setMessage("Staff details saved. Permissions take effect immediately.");
      router.refresh();
    } catch (error) {
      setFailed(true); setMessage(error instanceof Error ? error.message : "Unable to save changes.");
    } finally {
      const pin = form.elements.namedItem("pin");
      if (pin instanceof HTMLInputElement) pin.value = "";
      busy.current = false; setPending(false);
    }
  }
  if (created) return <CreatedCredentials id={created.id} pin={created.pin} clearPin={clearPin} />;
  return <form onSubmit={submit} aria-busy={pending} className="card space-y-5">
    <fieldset disabled={pending} className="space-y-4">
      <legend className="mb-4 text-lg font-semibold">Staff details</legend>
      <label className="block">Name<input className={inputClass} name="name" required maxLength={200} defaultValue={staff?.name} autoComplete="off" /></label>
      {!staff && <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Staff ID</legend><label className="flex items-center gap-2"><input type="radio" name="idMode" checked={automaticId} onChange={() => setAutomaticId(true)} />Generate a unique Staff ID automatically</label><label className="flex items-center gap-2"><input type="radio" name="idMode" checked={!automaticId} onChange={() => setAutomaticId(false)} />Set a custom Staff ID</label></fieldset>}
      {(!automaticId || staff) && <label className="block">{staff ? "Staff ID" : "Custom Staff ID"}<input className={inputClass} name="staffCode" required minLength={3} maxLength={32} defaultValue={staff?.staffCode} autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-describedby="staff-code-help" /></label>}
      <p id="staff-code-help" className="muted">{automaticId ? "The generated ID is shown after creation, together with the initial PIN." : "3–32 letters, numbers, underscores or hyphens. Saved in uppercase; must be unique."}</p>
      {!staff && <PinField label="Initial PIN" />}
      <fieldset className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <legend className="px-1 font-medium">Location and service permissions</legend>
        <p className="muted">Select up to 25 services. Only active locations and services grant queue access.</p>
        <p className="text-sm font-semibold text-teal-800">{selectedServices.size} / 25 services selected</p>
        {options.locations.map((location) => {
          const group = options.services.filter((s) => s.locationId === location.id);
          const count = group.filter((s) => selectedServices.has(s.id)).length;
          return <fieldset key={location.id} className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
            <legend className="px-1 text-sm font-semibold">{location.name}{!location.active && " · Inactive"}</legend>
            <div className="mb-3 flex flex-wrap items-center gap-2"><span className="mr-auto text-xs text-slate-500">{count} of {group.length} selected</span>
              <button type="button" className="btn-link text-xs" disabled={!group.length || count === group.length || selectedServices.size - count + group.length > 25} onClick={() => setSelectedServices((previous) => new Set([...previous, ...group.map((s) => s.id)]))}>Select all<span className="sr-only"> at {location.name}</span></button>
              <button type="button" className="btn-link text-xs" disabled={!count} onClick={() => setSelectedServices((previous) => new Set([...previous].filter((id) => !group.some((s) => s.id === id))))}>Clear<span className="sr-only"> {location.name}</span></button>
            </div>
            <div className="flex flex-wrap gap-2">{group.map((service) => <label key={service.id} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${selectedServices.has(service.id) ? "border-teal-300 bg-teal-50" : "border-slate-200"}`}>
              <input type="checkbox" name="service" value={service.id} checked={selectedServices.has(service.id)} disabled={!selectedServices.has(service.id) && selectedServices.size >= 25} onChange={(event) => setSelectedServices((previous) => { const next = new Set(previous); if (event.target.checked && next.size < 25) next.add(service.id); else next.delete(service.id); return next; })} />
              <span>{service.name}{!service.active && <span className="ml-1 text-xs text-slate-500">(inactive)</span>}</span>
            </label>)}</div>
            {!group.length && <p className="muted">No services configured.</p>}
          </fieldset>;
        })}
        {!options.locations.length && <p>No locations configured yet.</p>}
      </fieldset>
      <button className={buttonClass} type="submit">{pending ? "Saving…" : staff ? "Save details" : "Create staff member"}</button>
    </fieldset>
    {message && <p role={failed ? "alert" : "status"}>{message}</p>}
  </form>;
}

export function StaffAccountForms({ staff }: { staff: StaffView }) {
  const router = useRouter();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>, operation: "pin" | "status") {
    event.preventDefault();
    if (busy.current) return;
    if (!window.confirm(operation === "pin" ? "Reset this PIN and sign out all active staff sessions?" : `${staff.active ? "Disable" : "Enable"} this staff account? ${staff.active ? "All active sessions will be signed out." : "The staff member can sign in with their current PIN."}`)) return;
    busy.current = true;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setPending(true); setMessage(""); setFailed(false);
    try {
      await send(`/api/manager/staff/${staff.id}/${operation}`, "POST", operation === "pin" ? { pin: fields.get("pin") } : { active: !staff.active });
      setMessage(operation === "pin" ? "PIN reset. All staff sessions have been signed out." : staff.active ? "Account disabled. All staff sessions have been signed out." : "Account enabled. The staff member must sign in again.");
      router.refresh();
    } catch (error) {
      setFailed(true); setMessage(error instanceof Error ? error.message : "Unable to save changes.");
    } finally {
      form.reset(); busy.current = false; setPending(false);
    }
  }
  return <section className="card space-y-6" aria-busy={pending}>
    <form onSubmit={(event) => submit(event, "pin")}>
      <fieldset disabled={pending} className="space-y-3">
        <legend className="mb-3 text-lg font-semibold">Reset PIN</legend>
        <PinField label="New PIN" />
        <p className="muted">Resetting signs out all active sessions.</p>
        <button className={buttonClass} type="submit">Reset PIN and sign out staff</button>
      </fieldset>
    </form>
    <form onSubmit={(event) => submit(event, "status")} className="space-y-3 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold">Account status: {staff.active ? "Enabled" : "Disabled"}</h2>
      <p className="muted">Disabling blocks login and signs out all sessions. Finish active tickets first.</p>
      <button className={`btn ${staff.active ? "btn-danger" : "btn-primary"}`} disabled={pending} type="submit">{staff.active ? "Disable account" : "Enable account"}</button>
    </form>
    {message && <p role={failed ? "alert" : "status"}>{message}</p>}
  </section>;
}
