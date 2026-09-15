import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle } from "@/lib/auth/http";
import { listStaff, managerSession, mutateStaff } from "@/lib/staff/management";

export function GET(request: NextRequest) {
  return handle(async () => NextResponse.json({ staff: await listStaff(await managerSession(request)) }));
}

export function POST(request: NextRequest) {
  return handle(async () => {
    checkOrigin(request);
    return NextResponse.json(await mutateStaff(request, "create"), { status: 201 });
  });
}
