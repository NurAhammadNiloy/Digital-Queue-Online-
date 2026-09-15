import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle } from "@/lib/auth/http";
import { getStaff, managerSession, mutateStaff } from "@/lib/staff/management";

type Context = { params: Promise<{ id: string }> };
export function GET(request: NextRequest, context: Context) {
  return handle(async () => NextResponse.json({ staff: await getStaff(await managerSession(request), (await context.params).id) }));
}
export function PUT(request: NextRequest, context: Context) {
  return handle(async () => {
    checkOrigin(request);
    return NextResponse.json(await mutateStaff(request, "update", (await context.params).id));
  });
}
