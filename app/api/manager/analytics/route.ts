import { NextResponse, type NextRequest } from "next/server";
import { handle, HttpError, requireApiSession } from "@/lib/auth/http";
import { sessionCookieName } from "@/lib/auth/session";
import { analyticsRange } from "@/lib/analytics/filters";
import { managerAnalytics } from "@/lib/analytics/manager";
import { requiredLocation } from "@/lib/manager/location-selection";
export function GET(request: NextRequest) {
  return handle(async () => {
    await requireApiSession(request, "manager");
    const range = analyticsRange(request.nextUrl.searchParams);
    if (!range) throw new HttpError(400, "Invalid analytics filter.");
    return NextResponse.json(await managerAnalytics(request.cookies.get(sessionCookieName("manager"))!.value, requiredLocation(request.nextUrl.searchParams, true), range));
  });
}
