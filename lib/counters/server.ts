import "server-only";
import type { NextRequest } from "next/server";
import { HttpError, readObjectBody, requireApiSession } from "@/lib/auth/http";
import { sessionCookieName, tokenHash } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { uuid } from "@/lib/staff/validation";
import type { CounterOperations, StaffCounterState } from "./types";

export function counterError(error: { code?: string; message?: string } | null) {
  if (!error) return;
  if (error.code === "42501") throw new HttpError(403, "Counter access is not permitted. Check your current assignment.");
  if (error.code === "P0002") throw new HttpError(404, "Counter or location is unavailable.");
  if (error.code === "23505") throw new HttpError(409, "Counter name or session is already in use. Refresh and check availability.");
  if (error.code === "23514") throw new HttpError(409, error.message?.startsWith("Restore") ? "Restore this record and its parent location before editing." : "The counter or ticket changed, or live work remains. Refresh and resolve the current ticket/session before retrying.");
  if (["55P03", "40P01"].includes(error.code ?? "")) throw new HttpError(409, "A related operation is in progress. Refresh and try again.");
  if (["22023", "22P02"].includes(error.code ?? "")) throw new HttpError(400, "Invalid counter details.");
  throw new Error("Counter operation unavailable.");
}
export async function counterOperations(token: string, locationId: string, includeArchived = false): Promise<CounterOperations> {
  const { data, error } = await createAdminClient().rpc("get_manager_counter_operations", { p_token_hash: tokenHash(token), p_location_id: uuid(locationId), p_include_archived: includeArchived });
  counterError(error);
  if (!data) throw new Error("Counter view unavailable.");
  return data as unknown as CounterOperations;
}
export async function staffCounterState(token: string, locationId?: string, serviceId?: string): Promise<StaffCounterState> {
  const { data, error } = await createAdminClient().rpc("get_staff_counter_state", { p_token_hash: tokenHash(token), p_location_id: locationId, p_service_id: serviceId });
  counterError(error);
  if (!data) throw new Error("Counter view unavailable.");
  return data as unknown as StaffCounterState;
}
export async function mutateManagerCounter(request: NextRequest, locationId: string) {
  await requireApiSession(request, "manager");
  const body = await readObjectBody(request, ["action", "counterId", "name", "sessionId", "ticketId"]);
  if (body.action === "skip-release") {
    if (body.name !== undefined) throw new HttpError(400, "Invalid fields.");
    const { data, error } = await createAdminClient().rpc("skip_release_counter", {
      p_token_hash: tokenHash(request.cookies.get(sessionCookieName("manager"))!.value), p_location_id: uuid(locationId),
      p_counter_id: uuid(body.counterId), p_session_id: uuid(body.sessionId), p_ticket_id: uuid(body.ticketId),
    });
    counterError(error); return { id: data };
  }
  if (body.sessionId !== undefined || body.ticketId !== undefined || typeof body.action !== "string" || !["create", "rename", "enable", "disable", "release"].includes(body.action)) throw new HttpError(400, "Invalid action.");
  if (body.action === "create" && body.counterId !== undefined) throw new HttpError(400, "Invalid counter.");
  const naming = ["create", "rename"].includes(body.action);
  if (naming ? typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80 : body.name !== undefined) throw new HttpError(400, "Enter a counter name of 1–80 characters.");
  const { data, error } = await createAdminClient().rpc("manage_location_counter", {
    p_token_hash: tokenHash(request.cookies.get(sessionCookieName("manager"))!.value), p_location_id: uuid(locationId),
    p_action: body.action, p_counter_id: body.action === "create" ? undefined : uuid(body.counterId),
    p_name: naming ? (body.name as string).trim() : undefined,
  });
  counterError(error); return { id: data };
}
export async function mutateStaffCounter(request: NextRequest) {
  await requireApiSession(request, "staff");
  const body = await readObjectBody(request, ["action", "locationId", "serviceId", "counterId"]);
  if (!["start", "end"].includes(String(body.action))) throw new HttpError(400, "Invalid action.");
  if (body.action === "end" && Object.keys(body).length !== 1) throw new HttpError(400, "Invalid fields.");
  const { data, error } = await createAdminClient().rpc("manage_staff_counter", {
    p_token_hash: tokenHash(request.cookies.get(sessionCookieName("staff"))!.value), p_action: body.action as string,
    p_location_id: body.action === "start" ? uuid(body.locationId) : undefined,
    p_service_id: body.action === "start" ? uuid(body.serviceId) : undefined,
    p_counter_id: body.action === "start" ? uuid(body.counterId) : undefined,
  });
  counterError(error); return { id: data };
}
