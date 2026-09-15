import "server-only";
import { HttpError } from "@/lib/auth/http";
import { tokenHash } from "@/lib/auth/session";
import { dashboard } from "@/lib/manager/administration";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";
import type { AnalyticsRange, ManagerAnalytics } from "@/lib/analytics/types";

function object(value: Json | undefined): { [key: string]: Json | undefined } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid analytics response.");
  return value;
}
function string(value: Json | undefined) {
  if (typeof value !== "string") throw new Error("Invalid analytics response.");
  return value;
}
function average(value: Json | undefined) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid analytics response.");
  return value;
}
function metadata(value: Json) {
  const row = object(value);
  if (typeof row.active !== "boolean" || typeof row.servedCount !== "number" || !Number.isSafeInteger(row.servedCount) || row.servedCount < 0) throw new Error("Invalid analytics response.");
  return { id: string(row.id), name: string(row.name), active: row.active, servedCount: row.servedCount, averageServiceSeconds: average(row.averageServiceSeconds) };
}
export async function managerAnalytics(token: string, locationId: string, range: AnalyticsRange): Promise<ManagerAnalytics> {
  // Reuse dashboard semantics for the two live cards. Filtered history is a
  // separate database snapshot; live counts can advance during a queue action.
  const [current, result] = await Promise.all([
    dashboard(token, locationId), createAdminClient().rpc("get_manager_analytics", { p_token_hash: tokenHash(token), p_location_id: locationId, p_range: range }),
  ]);
  if (result.error?.code === "42501") throw new HttpError(403, "Access denied.");
  if (result.error?.code === "P0002") throw new HttpError(404, "Location not found.");
  if (result.error) throw new Error("Analytics unavailable.");
  const data = object(result.data);
  if (!Array.isArray(data.services) || !Array.isArray(data.staff)) throw new Error("Invalid analytics response.");
  if (typeof data.servedCount !== "number" || !Number.isSafeInteger(data.servedCount) || data.servedCount < 0) throw new Error("Invalid analytics response.");
  if (!["hour", "day", "month"].includes(String(data.bucketUnit)) || !Array.isArray(data.servedOverTime)) throw new Error("Invalid chart response.");
  const servedOverTime = data.servedOverTime.map((value) => {
    const row = object(value), start = string(row.start);
    if (!Number.isFinite(Date.parse(start)) || typeof row.servedCount !== "number" || !Number.isSafeInteger(row.servedCount) || row.servedCount < 0) throw new Error("Invalid chart response.");
    return { start, servedCount: row.servedCount };
  });
  return {
    range, asOf: string(data.asOf),
    bucketUnit: data.bucketUnit as ManagerAnalytics["bucketUnit"], servedOverTime,
    summary: { servedCount: data.servedCount, servedToday: current.servedToday, waitingNow: current.waitingNow, averageWaitSeconds: average(data.averageWaitSeconds), averageServiceSeconds: average(data.averageServiceSeconds) },
    services: data.services.map((value) => ({ ...metadata(value), locationName: string(object(value).locationName), averageWaitSeconds: average(object(value).averageWaitSeconds) })),
    staff: data.staff.map(metadata),
  };
}
