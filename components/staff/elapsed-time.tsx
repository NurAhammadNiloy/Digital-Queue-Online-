"use client";

import { useEffect, useState } from "react";

/** Display-only clock, isolated from queue fetching and action state. */
export function ElapsedTime({ since, serving = false }: { since: string; serving?: boolean }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setNow(Date.now());
    const initial = window.setTimeout(update, 0);
    const interval = window.setInterval(update, 1000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
  }, []);

  const started = Date.parse(since);
  const seconds = now === null || !Number.isFinite(started) ? null : Math.max(0, Math.floor((now - started) / 1000));
  const duration = seconds === null ? "—" : `${Math.floor(seconds / 60)} min ${seconds % 60} sec`;

  return <span className="tabular-nums" aria-live="off">{serving ? `Serving for ${duration}` : `Waiting ${duration}`}</span>;
}
