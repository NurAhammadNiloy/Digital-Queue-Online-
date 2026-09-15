import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle } from "@/lib/auth/http";
import { clearLocationHistory } from "@/lib/analytics/clear-history";

export function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    checkOrigin(request);
    return NextResponse.json(await clearLocationHistory(request, (await context.params).id));
  });
}
