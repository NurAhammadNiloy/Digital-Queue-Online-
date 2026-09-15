import { NextResponse, type NextRequest } from "next/server";
import { handle } from "@/lib/auth/http";
import { publicLocation, rejectQuery } from "@/lib/customer/queue";
import { consumePublicAttempt } from "@/lib/customer/rate-limit";

export function GET(request: NextRequest, context: { params: Promise<{ locationSlug: string }> }) {
  return handle(async () => {
    await consumePublicAttempt(request.headers, "read"); rejectQuery(request);
    return NextResponse.json({ location: await publicLocation((await context.params).locationSlug) });
  });
}
