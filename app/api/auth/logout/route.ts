import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, handle, HttpError } from "@/lib/auth/http";
import { revokeSession, sessionCookieName, setSessionCookie } from "@/lib/auth/session";

export function POST(request: NextRequest) {
  return handle(async () => {
    checkOrigin(request);
    const query = request.nextUrl.searchParams, role = query.get("role");
    if ([...query.keys()].some((key) => key !== "role") || query.getAll("role").length > 1 || (role !== null && role !== "staff" && role !== "manager")) throw new HttpError(400, "Invalid session selection.");
    const present = (["staff", "manager"] as const).filter((candidate) => request.cookies.has(sessionCookieName(candidate)));
    if (!role && present.length > 1) throw new HttpError(400, "Select which role to log out.");
    const selected = role ? [role] as const : present;
    for (const candidate of selected) await revokeSession(request.cookies.get(sessionCookieName(candidate))?.value);
    const response = request.headers.get("content-type")?.startsWith("application/json")
      ? NextResponse.json({ ok: true }) : NextResponse.redirect(new URL("/", request.url), 303);
    for (const candidate of selected) setSessionCookie(response, "", new Date(0), candidate);
    return response;
  });
}
