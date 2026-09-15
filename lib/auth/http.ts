import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { readSession, sessionCookieName, type Role } from "@/lib/auth/session";
import { logDevelopmentError } from "@/lib/shared/development-error";

export class HttpError extends Error {
  constructor(public status: number, message: string, public retryAfter = 900) { super(message); }
}

export function appOrigin() {
  const value = process.env.APP_ORIGIN ?? (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : "");
  const url = new URL(value);
  if (url.origin !== value || (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("APP_ORIGIN must be an HTTPS origin (HTTP is allowed only on loopback).");
  }
  return value;
}

export function checkOrigin(request: Request) {
  if (request.headers.get("origin") !== appOrigin() || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new HttpError(403, "Request origin is not allowed.");
  }
}

export function privateResponse(response: NextResponse) {
  response.headers.set("Cache-Control", response.headers.get("Content-Type") === "text/event-stream" ? "private, no-store, no-transform" : "private, no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export async function handle(handler: () => Promise<NextResponse>) {
  try { return privateResponse(await handler()); }
  catch (error) {
    const status = error instanceof HttpError ? error.status : 503;
    if (status >= 500) logDevelopmentError(error, "api");
    // Never serialize SDK errors or request/credential values to the response.
    const response = NextResponse.json({ error: error instanceof HttpError ? error.message : "Service temporarily unavailable." }, { status });
    if (status === 429) response.headers.set("Retry-After", String(error instanceof HttpError ? error.retryAfter : 900));
    return privateResponse(response);
  }
}

export async function readObjectBody(request: Request, allowedKeys: string[]) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Invalid request.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 4096) { await reader.cancel(); throw new HttpError(413, "Request too large."); }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const contentType = request.headers.get("content-type")?.split(";")[0];
  let body: unknown;
  try {
    if (contentType === "application/json") body = JSON.parse(text);
    else if (contentType === "application/x-www-form-urlencoded") {
      const fields = new URLSearchParams(text);
      if (new Set(fields.keys()).size !== [...fields.keys()].length) throw new Error();
      body = Object.fromEntries(fields);
    } else throw new Error();
  } catch { throw new HttpError(400, "Invalid request."); }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !allowedKeys.includes(key))) {
    throw new HttpError(400, "Invalid request.");
  }
  return body as Record<string, unknown>;
}

/** Accept only string-valued login and queue fields. */
export async function readBody(request: Request, allowedKeys: string[]) {
  const body = await readObjectBody(request, allowedKeys);
  if (Object.values(body).some((value) => typeof value !== "string")) throw new HttpError(400, "Invalid request.");
  return body as Record<string, string>;
}

export async function requireApiSession(request: NextRequest, role?: Role) {
  if (!role) {
    const sessions = (await Promise.all((["staff", "manager"] as const).map((candidate) => readSession(request.cookies.get(sessionCookieName(candidate))?.value)))).filter((session) => session !== null);
    if (!sessions.length) throw new HttpError(401, "Authentication required.");
    if (sessions.length > 1) throw new HttpError(409, "Select a staff or manager session.");
    return sessions[0];
  }
  const token = request.cookies.get(sessionCookieName(role))?.value;
  const session = await readSession(token);
  // Preserve a clear forbidden-role response for callers carrying only the
  // other role. Never use that other session to authorize this request.
  if (!token && await readSession(request.cookies.get(sessionCookieName(role === "staff" ? "manager" : "staff"))?.value)) throw new HttpError(403, "Access denied. Sign in with the required role.");
  if (!session) throw new HttpError(401, "Authentication required.");
  if (role && session.role !== role) throw new HttpError(403, "Access denied.");
  return session;
}
