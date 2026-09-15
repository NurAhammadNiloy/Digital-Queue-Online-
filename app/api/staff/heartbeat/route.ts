import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle, HttpError, readObjectBody, requireApiSession } from "@/lib/auth/http";
import { sessionCookieName, tokenHash } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { counterError } from "@/lib/counters/server";

export function POST(request: NextRequest) {
  return handle(async () => {
    checkOrigin(request);
    await requireApiSession(request, "staff");
    if (request.nextUrl.searchParams.size) throw new HttpError(400, "Invalid query.");
    await readObjectBody(request, []);
    const { error } = await createAdminClient().rpc("heartbeat_staff_counter", {
      p_token_hash: tokenHash(request.cookies.get(sessionCookieName("staff"))!.value),
    });
    counterError(error);
    return NextResponse.json({ ok: true });
  });
}
