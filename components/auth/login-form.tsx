"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icon";
type Props = { role: "staff" | "manager" };

export function LoginForm({ role }: Props) {
  const router = useRouter(), busy = useRef(false);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const form = event.currentTarget, fields = new FormData(form);
    busy.current = true; setPending(true); setError("");
    try {
      const response = await fetch(`/api/auth/${role}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(fields)), cache: "no-store", signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok) throw new Error((data.error ?? "Unable to log in.") + (response.status === 429 ? ` Try again after ${response.headers.get("retry-after") ?? "900"} seconds.` : ""));
      form.reset(); router.replace(role === "staff" ? "/staff/dashboard" : "/manager"); router.refresh();
    } catch (cause) {
      setError(cause instanceof Error && !["TypeError", "TimeoutError"].includes(cause.name) ? cause.message : "Unable to reach the server. Check your connection and try again.");
      const secret = form.elements.namedItem(role === "staff" ? "pin" : "password");
      if (secret instanceof HTMLInputElement) { secret.value = ""; secret.focus(); }
    } finally { busy.current = false; setPending(false); }
  }
  return (
    <div className="login-background"><main className="mx-auto w-full max-w-md px-4 py-12 sm:py-20">
      <div className="brand mb-8 justify-center"><span className="brand-mark"><Icon name="queue" /></span>Digital Queue</div>
      <div className="card space-y-6">
      <header className="space-y-2"><h1>{role === "staff" ? "Staff" : "Manager"} login</h1><p className="muted">{role === "staff" ? "Sign in to serve your assigned queues." : "Sign in to manage your locations and team."}</p></header>
      <form action={`/api/auth/${role}/login`} method="post" onSubmit={submit} aria-busy={pending} className="space-y-5">
        <label className="block">
          {role === "staff" ? "Staff ID" : "Email"}
          <input className="field"
            name={role === "staff" ? "staffCode" : "email"} type={role === "staff" ? "text" : "email"}
            autoComplete="username" autoCapitalize={role === "staff" ? "characters" : "none"} spellCheck={false} maxLength={role === "staff" ? 32 : 254} required />
        </label>
        <label className="block">
          {role === "staff" ? "PIN" : "Password"}
          <input className="field" type="password" aria-describedby={error ? "login-error" : undefined}
            name={role === "staff" ? "pin" : "password"} autoComplete="current-password"
            inputMode={role === "staff" ? "numeric" : undefined}
            pattern={role === "staff" ? "[0-9]{6,12}" : undefined}
            maxLength={role === "staff" ? 12 : 1024} required />
        </label>
        {error && <p id="login-error" role="alert">{error}</p>}
        <button className="btn btn-primary w-full" disabled={pending} type="submit">{pending ? "Signing in…" : "Log in"}<Icon name="arrow" /></button>
      </form>
      </div>
      <p className="muted mt-6 text-center">Use the credentials provided by your organization.</p>
    </main></div>
  );
}
