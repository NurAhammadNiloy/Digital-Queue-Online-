"use client";
import { useId, useRef, useState } from "react";
import { ConfigForm, type ConfigFormProps } from "@/components/manager/config-form";

export function ConfigPanel({ label, primary = false, onBusyChange, ...props }: ConfigFormProps & { label: string; primary?: boolean; onBusyChange?: (pending: boolean) => void }) {
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), id = useId();
  function close() { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }
  return <div className="print:hidden">
    <button ref={trigger} type="button" className={`btn ${primary ? "btn-primary" : ""}`} aria-expanded={open} aria-controls={id} disabled={pending} onClick={() => open ? close() : setOpen(true)}>{open ? "Cancel" : label}</button>
    {open && <div id={id} className="mt-4 max-w-2xl rounded-xl border border-slate-200 bg-slate-50 p-4 sm:p-5"><ConfigForm {...props} onSaved={close} onPending={(value) => { setPending(value); onBusyChange?.(value); }} /></div>}
  </div>;
}
