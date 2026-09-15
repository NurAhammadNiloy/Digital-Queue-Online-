import { NextResponse, type NextRequest } from "next/server";
import { handle, HttpError, requireApiSession } from "@/lib/auth/http";

export function GET(request: NextRequest) {
  return handle(async () => {
    const query = request.nextUrl.searchParams, role = query.get("role");
    if ([...query.keys()].some((key) => key !== "role") || query.getAll("role").length > 1 || (role !== null && role !== "staff" && role !== "manager")) throw new HttpError(400, "Invalid session selection.");
    return NextResponse.json({ session: await requireApiSession(request, role ?? undefined) });
  });
}
