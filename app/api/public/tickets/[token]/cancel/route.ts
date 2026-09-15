import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle } from "@/lib/auth/http";
import { cancelTicket, rejectQuery } from "@/lib/customer/queue";
import { consumePublicAttempt } from "@/lib/customer/rate-limit";

export const runtime = "nodejs";
export function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  return handle(async () => {
    checkOrigin(request);
    await consumePublicAttempt(request.headers, "cancel");
    rejectQuery(request);
    return NextResponse.json({ ticket: await cancelTicket(request, (await context.params).token) });
  });
}
