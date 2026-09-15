"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CopyButton } from "@/components/manager/copy-button";

export function CreatedCredentials({ id, pin, clearPin }: { id: string; pin: string; clearPin: () => void }) {
  const router = useRouter(), heading = useRef<HTMLHeadingElement>(null);
  const [code, setCode] = useState<string | null>(null), [error, setError] = useState("");
  const [pending, setPending] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    heading.current?.focus();
    const controller = new AbortController();
    fetch(`/api/manager/staff/${id}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) })
      .then(async (response) => {
        if (!response.ok) throw new Error("ID lookup unavailable");
        const data = await response.json();
        if (typeof data.staff?.staffCode !== "string") throw new Error("Invalid ID response");
        if (!controller.signal.aborted) setCode(data.staff.staffCode);
      })
      .catch(() => { if (!controller.signal.aborted) setError("Staff was created, but its ID could not be loaded. Retry the ID lookup; do not create another account."); })
      .finally(() => { if (!controller.signal.aborted) setPending(false); });
    return () => controller.abort();
  }, [id, attempt]);
  useEffect(() => {
    // Memory only; discard on page exit or after the short handoff window.
    const timer = setTimeout(clearPin, 5 * 60 * 1000);
    window.addEventListener("pagehide", clearPin);
    return () => { clearTimeout(timer); window.removeEventListener("pagehide", clearPin); };
  }, [clearPin]);
  return <section className="card space-y-5 border-teal-200 print:hidden">
    <h2 ref={heading} tabIndex={-1}>Staff member created</h2>
    <p className="muted">Share these credentials securely. This new PIN is shown only here, for up to five minutes. It cannot be retrieved after leaving this page.</p>
    <dl className="space-y-4"><div><dt className="text-sm font-medium">Staff ID</dt><dd className="mt-2 flex flex-wrap items-center gap-3"><span className="break-all font-mono text-lg">{code ?? (pending ? "Loading…" : "Not loaded")}</span>{code && <CopyButton value={code} label="Copy Staff ID" />}</dd></div>
      <div><dt className="text-sm font-medium">Initial PIN</dt><dd className="mt-2 flex flex-wrap items-center gap-3">{pin ? <><span className="font-mono text-xl tracking-widest">{pin}</span><CopyButton value={pin} label="Copy PIN" /></> : <span className="muted">PIN cleared. Reset it on the staff page if needed.</span>}</dd></div></dl>
    {error && <><p role="alert">{error}</p><button type="button" className="btn" disabled={pending} onClick={() => { setPending(true); setError(""); setAttempt((value) => value + 1); }}>Retry Staff ID lookup</button></>}
    <button type="button" className="btn btn-primary" onClick={() => { clearPin(); router.replace(`/manager/staff/${id}`); }}>Done — manage staff</button>
  </section>;
}
