import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle } from "@/lib/auth/http";
import { mutateConfig } from "@/lib/manager/administration";
export function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    checkOrigin(request);
    return NextResponse.json(await mutateConfig(request, "create-service", (await context.params).id), { status: 201 });
  });
}
