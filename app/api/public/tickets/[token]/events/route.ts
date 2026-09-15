import type { NextRequest } from "next/server";
import { handle, HttpError } from "@/lib/auth/http";
import { consumePublicAttempt } from "@/lib/customer/rate-limit";
import { isRandomToken } from "@/lib/customer/input";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkStreamRequest, limitStream, queueEventStream } from "@/lib/realtime/server";
export const runtime = "nodejs";
export const maxDuration = 60;
export function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  return handle(async () => {
    checkStreamRequest(request);
    await consumePublicAttempt(request.headers, "read");
    if (request.nextUrl.searchParams.size) throw new HttpError(400, "Invalid request.");
    const { token } = await context.params;
    if (!isRandomToken(token)) throw new HttpError(404, "Ticket not found.");
    const { data, error } = await createAdminClient().from("queue_tickets").select("service_id,status").eq("ticket_token", token).maybeSingle();
    if (error) throw new Error("Ticket lookup unavailable.");
    if (!data) throw new HttpError(404, "Ticket not found.");
    if (["COMPLETED", "SKIPPED", "CANCELLED"].includes(data.status)) throw new HttpError(409, "Ticket is already closed.");
    await limitStream(`ticket:${token}`);
    // Ticket bearer tokens are immutable. The 45-second lease rechecks existence
    // on reconnect; terminal status/404 closes the browser subscription.
    return queueEventStream(request, `queue:service:${data.service_id}`, async () => true);
  });
}
