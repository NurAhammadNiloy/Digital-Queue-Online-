"use client";
import { useEffect } from "react";
import { watchQueue } from "@/lib/realtime/live-updates";
export function useQueueUpdates(url: string | null, refresh: () => Promise<number | false | void>, pollMs: number, enabled = true) {
  useEffect(() => {
    if (enabled) return watchQueue(url, refresh, pollMs);
  }, [url, refresh, pollMs, enabled]);
}
