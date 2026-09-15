import type { NextRequest } from "next/server";
import { handle, HttpError, requireApiSession } from "@/lib/auth/http";
import { uuid } from "@/lib/staff/validation";
import { checkStreamRequest, limitStream, queueEventStream, sessionAccess } from "@/lib/realtime/server";
export const runtime = "nodejs";
export const maxDuration = 60;
export function GET(request: NextRequest) {
  return handle(async () => {
    checkStreamRequest(request);
    const session = await requireApiSession(request, "staff");
    const query = request.nextUrl.searchParams;
    if (session.role !== "staff") throw new HttpError(403, "Access denied.");
    if ([...query.keys()].some((key) => key !== "serviceId") || query.getAll("serviceId").length !== 1) throw new HttpError(400, "Select one service.");
    const serviceId = uuid(query.get("serviceId")), assignment = session.assignments.find((a) => a.serviceId === serviceId);
    if (!assignment) throw new HttpError(403, "Service is not assigned to you.");
    await limitStream(`staff:${session.id}`);
    return queueEventStream(request, `queue:service:${serviceId}`, sessionAccess(request, "staff", assignment.locationId, serviceId));
  });
}
