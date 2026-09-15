import type { NextRequest } from "next/server";
import { handle, requireApiSession } from "@/lib/auth/http";
import { requiredLocation } from "@/lib/manager/location-selection";
import { locationDetails } from "@/lib/manager/administration";
import { checkStreamRequest, limitStream, queueEventStream, sessionAccess } from "@/lib/realtime/server";
export const runtime = "nodejs";
export const maxDuration = 60;
export function GET(request: NextRequest) {
  return handle(async () => {
    checkStreamRequest(request);
    const session = await requireApiSession(request, "manager");
    if (session.role !== "manager") throw new Error("Invalid manager session.");
    const locationId = requiredLocation(request.nextUrl.searchParams);
    await locationDetails(session, locationId);
    await limitStream(`manager:${session.id}`);
    return queueEventStream(request, `queue:location:${locationId}`, sessionAccess(request, "manager", locationId));
  });
}
