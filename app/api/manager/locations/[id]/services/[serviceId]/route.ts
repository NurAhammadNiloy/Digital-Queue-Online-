import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle } from "@/lib/auth/http";
import { mutateConfig } from "@/lib/manager/administration";
export function PUT(request: NextRequest, context: { params: Promise<{ id: string; serviceId: string }> }) {
  return handle(async () => {
    checkOrigin(request);
    const { id, serviceId } = await context.params;
    return NextResponse.json(await mutateConfig(request, "update-service", id, serviceId));
  });
}
