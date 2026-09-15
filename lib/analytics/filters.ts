import type { AnalyticsRange } from "./types.ts";
export const analyticsRanges: { value: AnalyticsRange; label: string }[] = [
  { value: "today", label: "Today" }, { value: "7days", label: "Last 7 days" }, { value: "month", label: "This month" }, { value: "all", label: "All time" },
];
export function analyticsRange(query: URLSearchParams): AnalyticsRange | null {
  if ([...query.keys()].some((key) => !["range", "locationId"].includes(key)) || query.getAll("range").length > 1 || query.getAll("locationId").length > 1) return null;
  const value = query.get("range") ?? "today";
  return analyticsRanges.find((range) => range.value === value)?.value ?? null;
}
export function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded} sec`;
  const minutes = Math.floor(rounded / 60), remainder = rounded % 60;
  return `${minutes} min${remainder ? ` ${remainder} sec` : ""}`;
}
