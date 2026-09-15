import "server-only";
import { HttpError } from "@/lib/auth/http";
import type { StaffSession } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import type { ServingTicket, StaffQueueState } from "@/lib/staff/serving-types";
import { staffCounterState } from "@/lib/counters/server";

const fields = "id,queue_number,customer_name,location_id,service_id,joined_at,started_at,counter_name" as const;
type TicketRow = Pick<Database["public"]["Tables"]["queue_tickets"]["Row"],
  "id" | "queue_number" | "customer_name" | "location_id" | "service_id" | "joined_at" | "started_at" | "counter_name">;
const safeTicket = (t: TicketRow): ServingTicket => ({
  id: t.id, queueNumber: t.queue_number!, customerName: t.customer_name,
  locationId: t.location_id, serviceId: t.service_id, joinedAt: t.joined_at, startedAt: t.started_at, counterName: t.counter_name,
});

export function queueQuery(params: URLSearchParams) {
  if ([...params.keys()].some((key) => !["serviceId", "page"].includes(key)) || params.getAll("serviceId").length > 1 || params.getAll("page").length > 1) {
    throw new HttpError(400, "Invalid request.");
  }
  const serviceId = params.get("serviceId") ?? undefined;
  if (serviceId !== undefined && (serviceId.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(serviceId))) throw new HttpError(400, "Invalid service.");
  const page = params.get("page") ?? "1";
  if (!/^[1-9][0-9]{0,4}$/.test(page)) throw new HttpError(400, "Invalid page.");
  return { serviceId: serviceId?.toLowerCase(), page: Number(page) };
}

/** Called only after the existing database session guard, never with browser identity. */
export async function staffQueueState(session: StaffSession, token: string, serviceId?: string, page = 1): Promise<StaffQueueState> {
  const client = createAdminClient();
  const assignments = [];
  if (session.assignments.length) {
    const { data, error } = await client.from("services").select("id,name,location_id,locations!inner(name,active,timezone)")
      .eq("organization_id", session.organizationId).eq("active", true).eq("locations.active", true)
      .in("id", session.assignments.map((a) => a.serviceId)).order("name").order("id");
    if (error) throw new Error("Staff assignments unavailable.");
    for (const s of data) {
      if (session.assignments.some((a) => a.serviceId === s.id && a.locationId === s.location_id)) {
        assignments.push({ serviceId: s.id, serviceName: s.name, locationId: s.location_id, locationName: s.locations.name, locationTimezone: s.locations.timezone });
      }
    }
  }
  // The current ticket is the caller's own, regardless of the selected service.
  // A removed permission only exposes a blocked flag, never the revoked queue's PII.
  const current = await client.from("queue_tickets").select(fields).eq("organization_id", session.organizationId)
    .eq("served_by_staff_id", session.id).eq("status", "SERVING").maybeSingle();
  if (current.error) throw new Error("Current ticket unavailable.");
  const currentTicket = current.data;
  const servingAllowed = currentTicket && assignments.some((a) => a.serviceId === currentTicket.service_id && a.locationId === currentTicket.location_id);
  const serving = servingAllowed && currentTicket ? safeTicket(currentTicket) : null;
  const ownCounter = await staffCounterState(token);
  const requested = serviceId ? assignments.find((a) => a.serviceId === serviceId) : undefined;
  if (serviceId && !requested) throw new HttpError(403, "Service is not assigned to you.");
  // Database work takes precedence over an old tab's selection. Never switch an
  // active counter because a browser remembered another authorized service.
  const selected = assignments.find((a) => a.serviceId === (serving?.serviceId ?? ownCounter.counterSession?.serviceId)) ?? requested ?? assignments[0];
  if (serviceId && selected?.serviceId !== serviceId) page = 1;
  const state: StaffQueueState = {
    ...(selected ? await staffCounterState(token, selected.locationId, selected.serviceId) : ownCounter),
    staffName: session.name, assignments, selectedServiceId: selected?.serviceId ?? null,
    serving, servingAccessBlocked: Boolean(current.data && !servingAllowed),
    waiting: [], waitingTotal: 0, page, pageSize: 50,
  };
  if (selected) {
    // Exact tenant/location/service predicates and the same ordering as call-next.
    const result = await client.from("queue_tickets").select(fields, { count: "exact" })
      .eq("organization_id", session.organizationId).eq("location_id", selected.locationId).eq("service_id", selected.serviceId)
      .eq("status", "WAITING").order("joined_at").order("id")
      .range((page - 1) * state.pageSize, page * state.pageSize - 1);
    if (result.error) throw new Error("Waiting queue unavailable.");
    state.waiting = result.data.map(safeTicket); state.waitingTotal = result.count ?? 0;
    // If other staff drained the last page, return the first current page so
    // hidden pagination never strands a user on an empty, out-of-range page.
    if (page > 1 && !state.waiting.length) return staffQueueState(session, token, serviceId, 1);
  }
  return state;
}
