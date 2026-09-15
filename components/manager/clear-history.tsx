"use client";
import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function ClearHistory({ locationId, locationName }: { locationId: string; locationName: string }) {
  const router = useRouter(), id = useId();
  const dialog = useRef<HTMLDialogElement>(null), form = useRef<HTMLFormElement>(null), busy = useRef(false);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const fields = new FormData(event.currentTarget);
    busy.current = true; setPending(true); setError(""); setMessage("");
    try {
      const requestBody = JSON.stringify({ password: fields.get("password") });
      fields.delete("password"); form.current?.reset();
      const response = await fetch(`/api/manager/locations/${locationId}/analytics/history`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, cache: "no-store", body: requestBody,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(response.status === 429 ? `Too many password attempts. Try again in ${Math.ceil(Number(response.headers.get("retry-after") ?? 900) / 60)} minutes.` : data.error ?? "Unable to clear history.");
      setMessage(`${data.deletedCount} completed tickets deleted from ${locationName}. Queue numbering is unchanged.`);
      dialog.current?.close(); router.refresh();
    } catch (failure) {
      setError(failure instanceof Error && failure.name !== "TypeError" ? failure.message : "The result could not be confirmed. Refresh analytics to check before trying again.");
      router.refresh();
    } finally { fields.delete("password"); form.current?.reset(); busy.current = false; setPending(false); }
  }
  return <section className="border-t border-slate-200 pt-4 print:hidden" aria-label="Clear analytics history">
    <button type="button" className="btn btn-danger" onClick={() => { setError(""); setMessage(""); dialog.current?.showModal(); }}>Clear analytics history</button>
    {message && <p role="status" className="mt-3">{message}</p>}
    <dialog ref={dialog} className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl backdrop:bg-slate-950/50 sm:p-6" aria-labelledby={`${id}-title`} aria-describedby={`${id}-warning`} onCancel={(event) => { if (busy.current) event.preventDefault(); }} onClose={() => form.current?.reset()}>
      <form ref={form} onSubmit={submit} className="space-y-4" aria-busy={pending} autoComplete="off">
        <h2 id={`${id}-title`}>Permanently clear history?</h2>
        <p id={`${id}-warning`} className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">This permanently deletes ALL completed tickets for <strong>{locationName}</strong>, across every date—not just the selected filter. It cannot be undone. Deleted ticket links will stop working.</p>
        <p className="muted">Waiting, serving and skipped tickets, staff and settings stay. Today’s queue numbers will continue from the current number.</p>
        <fieldset disabled={pending} className="space-y-4"><label className="block">Your current manager password<input name="password" type="password" required maxLength={1024} autoComplete="off" className="field" /></label>
          <div className="flex flex-wrap justify-end gap-2"><button type="button" className="btn" onClick={() => dialog.current?.close()}>Cancel</button><button type="submit" className="btn btn-danger">{pending ? "Verifying and clearing…" : "Permanently delete completed history"}</button></div>
        </fieldset>
        {error && <p role="alert">{error}</p>}
      </form>
    </dialog>
  </section>;
}
