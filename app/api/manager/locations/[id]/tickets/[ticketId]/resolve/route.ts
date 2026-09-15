import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle } from "@/lib/auth/http";
import { resolveStuckTicket } from "@/lib/manager/recovery";

export function POST(request: NextRequest, context: { params: Promise<{ id: string; ticketId: string }> }) {
  return handle(async () => {
    checkOrigin(request);
    const { id, ticketId } = await context.params;
    return NextResponse.json(await resolveStuckTicket(request, id, ticketId));
  });
}
