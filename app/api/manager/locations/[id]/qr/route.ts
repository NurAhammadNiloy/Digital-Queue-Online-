import { NextResponse, type NextRequest } from "next/server";
import { handle, HttpError, requireApiSession } from "@/lib/auth/http";
import { locationDetails } from "@/lib/manager/administration";
import { locationQr, locationQrPoster } from "@/lib/manager/qr";
export function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const session = await requireApiSession(request, "manager");
    if (session.role !== "manager") throw new HttpError(403, "Access denied.");
    const params = request.nextUrl.searchParams;
    const allowed = new Set(["download", "poster"]);
    if ([...params.keys()].some((key) => !allowed.has(key)) || params.getAll("download").length > 1 || params.getAll("poster").length > 1 || (params.has("download") && params.get("download") !== "1") || (params.has("poster") && params.get("poster") !== "1")) throw new HttpError(400, "Invalid request.");
    const location = await locationDetails(session, (await context.params).id);
    const poster = params.has("poster");
    const body = poster ? locationQrPoster(location.slug, location.name) : locationQr(location.slug);
    const filename = poster ? `digital-queue-${location.slug}-poster.svg` : `queue-${location.slug}.svg`;
    return new NextResponse(body, { headers: {
      "Content-Type": "image/svg+xml; charset=utf-8", "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Disposition": `${params.has("download") ? "attachment" : "inline"}; filename="${filename}"`,
    } });
  });
}
