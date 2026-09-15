import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle } from "@/lib/auth/http";
import { joinQueue, rejectQuery } from "@/lib/customer/queue";
import { consumePublicAttempt } from "@/lib/customer/rate-limit";

export function POST(request: NextRequest, context: { params: Promise<{ locationSlug: string }> }) {
  return handle(async () => {
    checkOrigin(request);
    await consumePublicAttempt(request.headers, "join"); rejectQuery(request);
    return NextResponse.json(await joinQueue(request, (await context.params).locationSlug), { status: 201 });
  });
}
