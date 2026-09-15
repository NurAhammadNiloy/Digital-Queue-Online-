import "server-only";
import type { NextRequest } from "next/server";
import { HttpError, readObjectBody, requireApiSession } from "@/lib/auth/http";
import { sessionCookieName, tokenHash } from "@/lib/auth/session";
import { uuid } from "@/lib/staff/validation";
import { createAdminClient } from "@/lib/supabase/admin";

export async function resolveStuckTicket(request: NextRequest, locationId: string, ticketId: string) {
  await requireApiSession(request, "manager");
  if (request.nextUrl.searchParams.size) throw new HttpError(400, "Invalid query.");
  const body = await readObjectBody(request, ["action"]);
  if (body.action !== "skip" && body.action !== "complete") throw new HttpError(400, "Choose Skip or Complete.");
  const { data, error } = await createAdminClient().rpc("resolve_stuck_serving_ticket", {
    p_token_hash: tokenHash(request.cookies.get(sessionCookieName("manager"))!.value),
    p_location_id: uuid(locationId), p_ticket_id: uuid(ticketId), p_action: body.action,
  });
  if (error?.code === "42501") throw new HttpError(403, "Manager access is required.");
  if (error?.code === "P0002") throw new HttpError(404, "Ticket is unavailable at this location.");
  if (error?.code === "23514") throw new HttpError(409, "This ticket is no longer serving or now has an active counter session. Refresh before taking another action.");
  if (["55P03", "40P01", "40001"].includes(error?.code ?? "")) throw new HttpError(409, "A related operation is in progress. Refresh and try again.");
  if (["22023", "22P02"].includes(error?.code ?? "")) throw new HttpError(400, "Invalid recovery request.");
  if (error || !data) throw new Error("Ticket recovery unavailable.");
  return data;
}
