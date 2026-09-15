import { NextResponse, type NextRequest } from "next/server";
import { handle, HttpError, requireApiSession } from "@/lib/auth/http";
import { queueQuery, staffQueueState } from "@/lib/staff/serving";
import { sessionCookieName } from "@/lib/auth/session";

export function GET(request: NextRequest) {
  return handle(async () => {
    const session = await requireApiSession(request, "staff");
    if (session.role !== "staff") throw new HttpError(403, "Access denied.");
    const query = queueQuery(request.nextUrl.searchParams);
    return NextResponse.json(await staffQueueState(session, request.cookies.get(sessionCookieName("staff"))!.value, query.serviceId, query.page));
  });
}
