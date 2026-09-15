import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle, HttpError, requireApiSession } from "@/lib/auth/http";
import { mutateConfig } from "@/lib/manager/administration";
import { createAdminClient } from "@/lib/supabase/admin";

/** Preserve the existing scoped list/filter contract. */
export function GET(request: NextRequest) {
  return handle(async () => {
    const session = await requireApiSession(request, "manager");
    if ([...request.nextUrl.searchParams.keys()].some((key) => key !== "locationId")) {
      throw new HttpError(400, "Invalid request.");
    }
    const locationId = request.nextUrl.searchParams.get("locationId");
    if (locationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(locationId)) {
      throw new HttpError(400, "Invalid request.");
    }
    let query = createAdminClient().from("locations").select("id,name,slug,active")
      .eq("organization_id", session.organizationId);
    if (locationId) query = query.eq("id", locationId);
    const { data, error } = await query;
    if (error) throw new Error("Location lookup unavailable.");
    if (locationId && !data.length) throw new HttpError(404, "Location not found.");
    return NextResponse.json({ locations: data });
  });
}

export function POST(request: NextRequest) {
  return handle(async () => {
    checkOrigin(request);
    return NextResponse.json(await mutateConfig(request, "create-location"), { status: 201 });
  });
}
