import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle, HttpError, readBody, requireApiSession } from "@/lib/auth/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { sessionCookieName, tokenHash } from "@/lib/auth/session";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function POST(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  return handle(async () => {
    checkOrigin(request);
    const session = await requireApiSession(request, "staff");
    if (session.role !== "staff") throw new HttpError(403, "Access denied.");
    const { action } = await context.params;
    if (!["call-next", "complete", "skip"].includes(action)) throw new HttpError(404, "Not found.");
    const body = await readBody(request, action === "call-next" ? ["serviceId"] : ["ticketId"]);
    const value = action === "call-next" ? body.serviceId : body.ticketId;
    if (!value || !uuid.test(value)) throw new HttpError(400, "Invalid request.");
    // SQL derives identity from the session and locks authorization rows before
    // calling the existing queue RPC. No browser-supplied identity is forwarded.
    const result = await createAdminClient().rpc("perform_staff_queue_action", {
      p_token_hash: tokenHash(request.cookies.get(sessionCookieName("staff"))!.value),
      p_action: action,
      p_service_id: action === "call-next" ? value : undefined,
      p_ticket_id: action !== "call-next" ? value : undefined,
    });
    if (result.error) {
      if (result.error.code === "42501") throw new HttpError(403, "Access denied.");
      if (result.error.code === "23514" && result.error.message === "Start an active counter session for this service first") throw new HttpError(409, "Start an active counter session for this service first.");
      if (["23514", "P0002", "23505"].includes(result.error.code)) throw new HttpError(409, "Ticket is not available for this action.");
      throw new Error("Queue operation unavailable.");
    }
    const ticket = result.data?.[0];
    // Do not send customer bearer tokens to staff browsers.
    return NextResponse.json({ ticket: ticket ? {
      id: ticket.id, queueNumber: ticket.queue_number, customerName: ticket.customer_name,
      status: ticket.status, locationId: ticket.location_id, serviceId: ticket.service_id,
      startedAt: ticket.started_at, completedAt: ticket.completed_at, skippedAt: ticket.skipped_at, counterName: ticket.counter_name,
    } : null });
  });
}
