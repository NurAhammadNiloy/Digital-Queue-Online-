import { NextResponse, type NextRequest } from "next/server";
import { sessionCookieName } from "@/lib/auth/cookie-name";

export function proxy(request: NextRequest) {
  const role = request.nextUrl.pathname.startsWith("/staff") ? "staff" : "manager";
  const cookieName = sessionCookieName(role);
  // Optimistic redirect only. Every protected page/API validates in the DAL.
  const response = request.nextUrl.pathname !== `/${role}/login` && !request.cookies.get(cookieName)?.value
    ? NextResponse.redirect(new URL(`/${role}/login`, request.url)) : NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  // Native POST forms (login/logout) need their real same-origin Origin.
  // no-referrer makes browsers send Origin: null for navigation submissions.
  // same-origin still suppresses referrers to every external origin.
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("X-Frame-Options", "DENY");
  return response;
}

export const config = {
  matcher: ["/manager/:path*", "/staff/:path*"],
};
