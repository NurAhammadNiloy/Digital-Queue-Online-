"use client";
import { useEffect, useState } from "react";

/** Server snapshot plus monotonic elapsed time avoids dependence on the device clock. */
export function CounterPresence({ lastSeenAt, observedAt }: { lastSeenAt: string | null; observedAt: string }) {
  const [elapsed, setElapsed] = useState<{ observedAt: string; seconds: number } | null>(null);
  useEffect(() => {
    const start = performance.now();
    const interval = window.setInterval(() => setElapsed({ observedAt, seconds: (performance.now() - start) / 1000 }), 1000);
    return () => window.clearInterval(interval);
  }, [observedAt]);
  const age = lastSeenAt ? (Date.parse(observedAt) - Date.parse(lastSeenAt)) / 1000 + (elapsed?.observedAt === observedAt ? elapsed.seconds : 0) : Infinity;
  const online = Number.isFinite(age) && age < 90;
  return <span className={`badge ${online ? "badge-active" : "badge-inactive"}`} title="Online means a dashboard heartbeat was received within 90 seconds. Presence does not release a counter or change a ticket.">{online ? "Online" : "Disconnected"}</span>;
}
