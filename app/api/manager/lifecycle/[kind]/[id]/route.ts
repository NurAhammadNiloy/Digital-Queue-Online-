import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle } from "@/lib/auth/http";
import { entityLifecycle } from "@/lib/manager/lifecycle";
type Context = { params: Promise<{ kind: string; id: string }> };
export function GET(request: NextRequest, context: Context) {
  return handle(async () => { const { kind, id } = await context.params; return NextResponse.json(await entityLifecycle(request, kind, id, true)); });
}
export function POST(request: NextRequest, context: Context) {
  return handle(async () => { checkOrigin(request); const { kind, id } = await context.params; return NextResponse.json(await entityLifecycle(request, kind, id)); });
}
