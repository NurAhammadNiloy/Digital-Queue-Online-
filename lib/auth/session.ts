import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sessionCookieName } from "@/lib/auth/cookie-name";
export { sessionCookieName } from "@/lib/auth/cookie-name";

type BaseSession = { id: string; organizationId: string; name: string; expiresAt: string };
export type StaffSession = BaseSession & {
  role: "staff";
  assignments: { locationId: string; serviceId: string }[];
};
export type ManagerSession = BaseSession & { role: "manager" };
export type AuthSession = StaffSession | ManagerSession;
export type Role = AuthSession["role"];
export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
const validToken = (token?: string) => Boolean(token && /^[A-Za-z0-9_-]{43}$/.test(token));

export async function readSession(token?: string): Promise<AuthSession | null> {
  if (!validToken(token)) return null;
  const { data, error } = await createAdminClient().rpc("validate_app_session", { p_token_hash: tokenHash(token!) });
  if (error) throw new Error("Session validation unavailable.");
  return data as AuthSession | null;
}

export async function currentSession(role: Role) {
  return readSession((await cookies()).get(sessionCookieName(role))?.value);
}

export async function requirePageSession<R extends Role>(role: R) {
  const session = await currentSession(role);
  if (!session || session.role !== role) redirect(`/${role}/login`);
  return session as Extract<AuthSession, { role: R }>;
}

export async function issueSession(role: Role, identityId: string, credentialVersion: string, previous?: string) {
  const token = randomBytes(32).toString("base64url");
  const { data, error } = await createAdminClient().rpc("issue_app_session", {
    p_token_hash: tokenHash(token), p_role: role, p_identity_id: identityId,
    p_credential_version: credentialVersion,
    p_previous_token_hash: validToken(previous) ? tokenHash(previous!) : undefined,
  });
  if (error || !data) throw new Error("Session creation unavailable.");
  return { token, expiresAt: new Date(data) };
}

export async function revokeSession(token?: string) {
  if (!validToken(token)) return;
  const { error } = await createAdminClient().rpc("revoke_app_session", { p_token_hash: tokenHash(token!) });
  if (error) throw new Error("Session revocation unavailable.");
}

export function setSessionCookie(response: NextResponse, token: string, expires: Date, role: Role) {
  response.cookies.set(sessionCookieName(role), token, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax",
    path: "/", expires, maxAge: Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000)),
  });
}
