import { NextResponse, type NextRequest } from "next/server";
import { handle, requireApiSession } from "@/lib/auth/http";
import { sessionCookieName } from "@/lib/auth/session";
import { requiredLocation } from "@/lib/manager/location-selection";
import { dashboard } from "@/lib/manager/administration";
export function GET(request: NextRequest) {
  return handle(async () => {
    await requireApiSession(request, "manager");
    return NextResponse.json(await dashboard(request.cookies.get(sessionCookieName("manager"))!.value, requiredLocation(request.nextUrl.searchParams)));
  });
}
