"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CounterOperations } from "@/lib/counters/types";
import { useQueueUpdates } from "@/lib/realtime/use-queue-updates";
import { CounterPanel } from "./counter-panel";

export function LocationCounters({ locationId, initial, parentArchived = false }: { locationId: string; initial: CounterOperations; parentArchived?: boolean }) {
  const [data, setData] = useState<CounterOperations | null>(initial), [message, setMessage] = useState("");
  const read = useRef<AbortController | null>(null), router = useRouter();
  useEffect(() => () => read.current?.abort(), []);
  const refresh = useCallback(async () => {
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    try {
      const response = await fetch(`/api/manager/locations/${locationId}/counters?view=all`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (controller.signal.aborted) return;
      if ([401, 403, 404].includes(response.status)) {
        setData(null); setMessage("Counter access is no longer available.");
        if (response.status === 401) router.replace("/manager/login");
        return false;
      }
      if (!response.ok) throw new Error();
      const next: CounterOperations = await response.json();
      if (!controller.signal.aborted) { setData((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next); setMessage(""); }
    } catch { if (!controller.signal.aborted) setMessage("Counter updates are delayed. Showing the last known state; retrying automatically."); }
  }, [locationId, router]);
  useQueueUpdates(`/api/manager/events?locationId=${locationId}`, refresh, 10000);
  return <div className="space-y-3 print:hidden">{message && <p role="status">{message}</p>}<CounterPanel locationId={locationId} data={data} manage={Boolean(data)} parentArchived={parentArchived} refresh={refresh} /></div>;
}
