import { NextResponse, type NextRequest } from "next/server";
import { handle } from "@/lib/auth/http";
import { publicTicket, rejectQuery } from "@/lib/customer/queue";
import { consumePublicAttempt } from "@/lib/customer/rate-limit";

export function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  return handle(async () => {
    await consumePublicAttempt(request.headers, "read"); rejectQuery(request);
    return NextResponse.json({ ticket: await publicTicket((await context.params).token) });
  });
}
