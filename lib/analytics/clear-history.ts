import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { HttpError, readBody } from "@/lib/auth/http";
import { consumeLoginAttempt } from "@/lib/auth/rate-limit";
import { sessionCookieName, tokenHash } from "@/lib/auth/session";
import { locationDetails } from "@/lib/manager/administration";
import { managerSession } from "@/lib/staff/management";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSupabaseConfig } from "@/lib/supabase/config";

export async function clearLocationHistory(request: NextRequest, locationId: string) {
  const session = await managerSession(request);
  const location = await locationDetails(session, locationId);
  const admin = createAdminClient();
  // The email/identity comes exclusively from the validated manager session.
  const { data: identity, error: lookupError } = await admin.auth.admin.getUserById(session.id);
  if (lookupError || !identity.user?.email) throw new Error("Password verification unavailable.");
  const email = identity.user.email;
  await consumeLoginAttempt(request, "manager", email.trim().toLowerCase());
  const body = await readBody(request, ["password"]);
  if (!body.password || body.password.length > 1024) throw new HttpError(400, "Enter your current manager password.");
  const { url, publishableKey } = getSupabaseConfig();
  const client = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  let verifiedId: string | undefined;
  try {
    const { data, error } = await client.auth.signInWithPassword({ email, password: body.password });
    if (error) {
      if (error.status === 429) throw new HttpError(429, "Too many password attempts. Try again later.");
      if (!error.status || error.status >= 500) throw new Error("Password verification unavailable.");
      throw new HttpError(403, "Password could not be verified. Enter your current manager password.");
    }
    if (data.user?.id === session.id && data.session) verifiedId = data.user.id;
    // Revoke this temporary Supabase session before deletion. App cookies are
    // unchanged and Auth bearer tokens are never returned to the browser.
    if (data.session) {
      const { error: signOutError } = await client.auth.signOut({ scope: "local" });
      if (signOutError) throw new Error("Password verification unavailable.");
    }
  } finally { body.password = ""; }
  if (!verifiedId) throw new HttpError(403, "Password could not be verified.");
  const { data, error } = await admin.rpc("clear_manager_location_history", {
    p_token_hash: tokenHash(request.cookies.get(sessionCookieName("manager"))!.value),
    p_location_id: location.id, p_verified_user_id: verifiedId,
  });
  if (error?.code === "42501") throw new HttpError(403, "Manager access changed. Sign in again before clearing history.");
  if (error?.code === "P0002") throw new HttpError(404, "Location not found.");
  if (error || typeof data !== "number" || !Number.isSafeInteger(data) || data < 0) throw new Error("History clearing unavailable.");
  return { deletedCount: data };
}
