import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle, HttpError, requireApiSession } from "@/lib/auth/http";
import { sessionCookieName } from "@/lib/auth/session";
import { counterOperations, mutateManagerCounter } from "@/lib/counters/server";
export function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireApiSession(request, "manager");
    const query = request.nextUrl.searchParams;
    if ([...query.keys()].some((key) => key !== "view") || query.getAll("view").length > 1 || (query.has("view") && query.get("view") !== "all")) throw new HttpError(400, "Invalid query.");
    return NextResponse.json(await counterOperations(request.cookies.get(sessionCookieName("manager"))!.value, (await context.params).id, query.get("view") === "all"));
  });
}
export function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    checkOrigin(request);
    if (request.nextUrl.searchParams.size) throw new HttpError(400, "Invalid query.");
    return NextResponse.json(await mutateManagerCounter(request, (await context.params).id));
  });
}
