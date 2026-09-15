"use client";
import { useEffect } from "react";

/** Presence only. No unload handler, release call, queue action or stored identity. */
export function useStaffPresence(counterSessionId: string | null) {
  useEffect(() => {
    if (!counterSessionId) return;
    let stopped = false;
    let active: AbortController | null = null;
    async function heartbeat() {
      if (stopped || active) return;
      const controller = new AbortController(); active = controller;
      try {
        await fetch("/api/staff/heartbeat", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        });
        // Queue polling handles authentication/access errors. Never release work.
        // Keep bounded retries: another tab may refresh authentication without
        // changing this durable counter-session ID. Every retry is revalidated.
      } catch { /* Presence becomes stale; reconnect/next interval retries safely. */ }
      finally { if (active === controller) active = null; }
    }
    const resume = () => { if (document.visibilityState === "visible") void heartbeat(); };
    void heartbeat();
    const interval = window.setInterval(() => void heartbeat(), 25000);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      stopped = true; active?.abort(); window.clearInterval(interval);
      window.removeEventListener("online", resume); document.removeEventListener("visibilitychange", resume);
    };
  }, [counterSessionId]);
}
