import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle } from "@/lib/auth/http";
import { mutateStaff } from "@/lib/staff/management";

export function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    checkOrigin(request);
    return NextResponse.json(await mutateStaff(request, "set-active", (await context.params).id));
  });
}
