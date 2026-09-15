import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle, HttpError } from "@/lib/auth/http";
import { mutateStaffCounter } from "@/lib/counters/server";
export function POST(request: NextRequest) {
  return handle(async () => {
    checkOrigin(request);
    if (request.nextUrl.searchParams.size) throw new HttpError(400, "Invalid query.");
    return NextResponse.json(await mutateStaffCounter(request));
  });
}
