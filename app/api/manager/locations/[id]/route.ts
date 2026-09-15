import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle } from "@/lib/auth/http";
import { managerSession } from "@/lib/staff/management";
import { locationDetails, services, mutateConfig, mutateLocationLifecycle } from "@/lib/manager/administration";
type Context = { params: Promise<{ id: string }> };
export function GET(request: NextRequest, context: Context) {
  return handle(async () => {
    const session = await managerSession(request), { id } = await context.params;
    return NextResponse.json({ location: await locationDetails(session, id), services: await services(session, id) });
  });
}
export function PUT(request: NextRequest, context: Context) {
  return handle(async () => {
    checkOrigin(request);
    return NextResponse.json(await mutateConfig(request, "update-location", (await context.params).id));
  });
}
export function PATCH(request: NextRequest, context: Context) {
  return handle(async () => {
    checkOrigin(request);
    return NextResponse.json(await mutateLocationLifecycle(request, (await context.params).id));
  });
}
export function DELETE(request: NextRequest, context: Context) {
  return handle(async () => {
    checkOrigin(request);
    return NextResponse.json(await mutateLocationLifecycle(request, (await context.params).id, true));
  });
}
