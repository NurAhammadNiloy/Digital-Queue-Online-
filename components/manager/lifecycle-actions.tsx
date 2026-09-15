"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function LifecycleActions({ kind, id, name, archived, returnTo, onChanged, disabled = false }: {
  kind: "staff" | "services" | "counters" | "locations"; id: string; name: string; archived: boolean;
  returnTo?: string; onChanged?: () => Promise<unknown>; disabled?: boolean;
}) {
  const router = useRouter(), busy = useRef(false);
  const [pending, setPending] = useState(false), [message, setMessage] = useState("");
  async function act(restoring = false) {
    if (busy.current || disabled) return;
    busy.current = true; setPending(true); setMessage("");
    const url = `/api/manager/lifecycle/${kind}/${id}`;
    try {
      let action = "restore";
      if (!restoring) {
        const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
        const plan = await response.json();
        if (!response.ok) throw new Error(plan.error ?? "Unable to inspect this record.");
        if (plan.blocked) throw new Error("Resolve live tickets and active counter sessions first. Nothing was changed.");
        if (plan.archived && plan.action === "archive") throw new Error("This record is already archived. Its retained history/dependencies prevent permanent deletion.");
        action = plan.action;
      }
      const warning = action === "restore" ? `Restore “${name}”? It will remain inactive. Old sessions and permissions will not return. Reactivation/reassignment is a separate step.`
        : action === "permanent-delete" ? `Permanently delete “${name}”? The server found no history or dependencies. This cannot be undone.`
        : `Archive “${name}”? History will be preserved, but it will disappear from operational lists.${kind === "locations" ? " Its services and counters will also be archived. Location permissions will be removed." : kind === "staff" || kind === "services" ? " Related staff permissions will be removed." : " Its idle counter session will be ended."} Restore will not reactivate it or restore permissions.`;
      if (!window.confirm(warning)) return;
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }), cache: "no-store", signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to change this record.");
      if (result.outcome === "deleted" && returnTo) router.replace(returnTo);
      await onChanged?.(); router.refresh();
    } catch (error) {
      setMessage(error instanceof Error && !["TypeError", "TimeoutError", "SyntaxError"].includes(error.name) ? error.message : "The result could not be confirmed. Refresh before trying again; no automatic retry was sent.");
    } finally { busy.current = false; setPending(false); }
  }
  return <div className="space-y-2"><div className="flex flex-wrap gap-2">
    {archived && <button type="button" className="btn" disabled={pending || disabled} onClick={() => void act(true)}>Restore</button>}
    <button type="button" className="btn btn-danger" disabled={pending || disabled} onClick={() => void act()}>Delete</button>
  </div>{pending && <p role="status">Checking record…</p>}{message && <p role="alert">{message}</p>}</div>;
}
