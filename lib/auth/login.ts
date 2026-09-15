import "server-only";

import { createClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSupabaseConfig } from "@/lib/supabase/config";
import { checkOrigin, handle, HttpError, readBody } from "@/lib/auth/http";
import { consumeLoginAttempt } from "@/lib/auth/rate-limit";
import { issueSession, sessionCookieName, setSessionCookie, tokenHash, type Role } from "@/lib/auth/session";
import { verifyPin } from "@/lib/auth/pin";
import { isValidStaffCode, normalizeStaffCode } from "@/lib/auth/staff-code";

export function login(request: NextRequest, role: Role) {
  return handle(async () => {
    checkOrigin(request);
    const body = await readBody(request, role === "staff" ? ["staffCode", "pin"] : ["email", "password"]);
    const identifier = role === "staff" ? normalizeStaffCode(body.staffCode ?? "") : (body.email ?? "").trim().toLowerCase();
    await consumeLoginAttempt(request, role, identifier.slice(0, 254));
    let identityId: string | undefined;
    let version: string | undefined;
    const admin = createAdminClient();
    if (role === "staff") {
      const code = isValidStaffCode(identifier) ? identifier : "";
      const { data: staff, error } = await admin.from("staff").select("id,pin_hash,active").eq("staff_code", code).maybeSingle();
      if (error) throw new Error("Credential verification unavailable.");
      const valid = await verifyPin(body.pin ?? "", staff?.pin_hash);
      if (valid && staff?.active) { identityId = staff.id; version = tokenHash(staff.pin_hash); }
    } else {
      if (identifier.length > 254 || !identifier || !body.password || body.password.length > 1024) {
        throw new HttpError(401, "Invalid login credentials.");
      }
      const { data: contexts, error: contextError } = await admin.rpc("get_manager_login_context", { p_email: identifier });
      if (contextError) throw new Error("Credential verification unavailable.");
      const { url, publishableKey } = getSupabaseConfig();
      const auth = createClient(url, publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data, error } = await auth.auth.signInWithPassword({ email: identifier, password: body.password });
      // Supabase Auth verifies passwords; its bearer tokens never leave this server.
      if (!error && data.user && data.session) {
        const context = contexts.find((item) => item.user_id === data.user.id);
        const { error: signOutError } = await auth.auth.signOut({ scope: "local" });
        if (signOutError) throw new Error("Credential verification unavailable.");
        if (context) { identityId = context.user_id; version = context.credential_version; }
      } else if (error && error.status && error.status >= 500) {
        throw new Error("Credential verification unavailable.");
      }
    }
    if (!identityId || !version) throw new HttpError(401, "Invalid login credentials.");
    const session = await issueSession(role, identityId, version, request.cookies.get(sessionCookieName(role))?.value);
    const response = request.headers.get("content-type")?.startsWith("application/json")
      ? NextResponse.json({ ok: true })
      : NextResponse.redirect(new URL(role === "staff" ? "/staff/dashboard" : "/manager", request.url), 303);
    setSessionCookie(response, session.token, session.expiresAt, role);
    return response;
  });
}
