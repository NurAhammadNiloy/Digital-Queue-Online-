"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueueUpdates } from "@/lib/realtime/use-queue-updates";
import type { DashboardCounts } from "@/lib/manager/types";
import { Kpi } from "@/components/ui/kpi";
import type { ManagerAnalytics } from "@/lib/analytics/types";
import type { CounterOperations } from "@/lib/counters/types";
import { CounterPanel } from "@/components/manager/counter-panel";
import { duration } from "@/lib/analytics/filters";

type DashboardAnalytics = Pick<ManagerAnalytics, "summary" | "services">;

export function LiveDashboardCounts({ locationId, initial, initialAnalytics, initialOperations }: {
  locationId: string; initial: DashboardCounts;
  initialAnalytics: DashboardAnalytics | null; initialOperations: CounterOperations | null;
}) {
  const [counts, setCounts] = useState<DashboardCounts | null>(initial), [message, setMessage] = useState("");
  const [analytics, setAnalytics] = useState(initialAnalytics);
  const [operations, setOperations] = useState(initialOperations);
  const controller = useRef<AbortController | null>(null);
  const router = useRouter();
  useEffect(() => () => controller.current?.abort(), []);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    try {
      const response = await fetch(`/api/manager/dashboard?locationId=${locationId}`, { cache: "no-store", signal: AbortSignal.any([current.signal, AbortSignal.timeout(10000)]) });
      if (current.signal.aborted) return;
      if (response.status === 401) { setCounts(null); router.replace("/manager/login"); router.refresh(); return false; }
      if ([403, 404].includes(response.status)) { setCounts(null); setMessage("Location access is no longer available. Select another location or sign in again."); return false; }
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!current.signal.aborted) { setCounts(data); setMessage(""); }
      if (current.signal.aborted) return;
      // Reuse the same location-scoped refresh lifecycle for existing read APIs.
      const options = { cache: "no-store" as const, signal: AbortSignal.any([current.signal, AbortSignal.timeout(10000)]) };
      const [history, liveOperations] = await Promise.allSettled([
        fetch(`/api/manager/analytics?locationId=${locationId}&range=today`, options),
        fetch(`/api/manager/locations/${locationId}/counters`, options),
      ]);
      if (current.signal.aborted) return;
      const historyResponse = history.status === "fulfilled" ? history.value : null;
      if (historyResponse?.status === 401) { setCounts(null); router.replace("/manager/login"); router.refresh(); return false; }
      if (historyResponse && [403, 404].includes(historyResponse.status)) { setCounts(null); setMessage("Location access is no longer available. Select another location or sign in again."); return false; }
      const historyData: ManagerAnalytics | null = historyResponse?.ok ? await historyResponse.json().catch(() => null) : null;
      const operationsResponse = liveOperations.status === "fulfilled" ? liveOperations.value : null;
      if (operationsResponse && [401, 403, 404].includes(operationsResponse.status)) {
        setCounts(null); setOperations(null); setMessage("Location access is no longer available.");
        if (operationsResponse.status === 401) router.replace("/manager/login");
        return false;
      }
      const operationsData: CounterOperations | null = operationsResponse?.ok ? await operationsResponse.json().catch(() => null) : null;
      if (current.signal.aborted) return;
      setAnalytics(historyData ? { summary: historyData.summary, services: historyData.services } : null);
      if (operationsData) setOperations((old) => JSON.stringify(old) === JSON.stringify(operationsData) ? old : operationsData);
      if (!historyData || !operationsData) setMessage("Some details are temporarily unavailable. Showing last known counter state; retrying automatically.");
    } catch { if (!current.signal.aborted) setMessage("Live counts are temporarily unavailable. Showing the last known counts; retrying automatically."); }
  }, [locationId, router]);
  useQueueUpdates(`/api/manager/events?locationId=${locationId}`, refresh, 10000);

  return <>
    {counts && <><dl className="dashboard-kpis" aria-live="polite">
      <Kpi label="Waiting now" value={counts.waitingNow} icon="people" tone="amber" />
      <Kpi label="Currently serving" value={operations ? operations.servingTickets.length : counts.currentlyServing} icon="queue" tone="blue" />
      <Kpi label="Served today" value={counts.servedToday} icon="check" />
      <Kpi label="Average wait · today" value={duration(analytics?.summary.averageWaitSeconds ?? null)} tone="amber" />
      <Kpi label="Average service · today" value={duration(analytics?.summary.averageServiceSeconds ?? null)} tone="blue" />
    </dl>
    <CounterPanel locationId={locationId} data={operations} recover refresh={refresh} /></>}
    {message && <p role="status">{message}</p>}
  </>;
}
