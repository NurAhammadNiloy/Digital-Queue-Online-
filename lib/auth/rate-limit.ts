import "server-only";

import { createHmac } from "node:crypto";
import { trustedClientIp } from "@/lib/shared/request-ip";
import { createAdminClient } from "@/lib/supabase/admin";
import { HttpError } from "@/lib/auth/http";
import type { Role } from "@/lib/auth/session";

export async function consumeLoginAttempt(request: Request, role: Role, identifier: string) {
  const secret = process.env.AUTH_RATE_LIMIT_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_RATE_LIMIT_SECRET must contain at least 32 random characters.");
  // Only Vercel's overwritten IP header is trusted. Never trust arbitrary XFF.
  const ip = trustedClientIp(request.headers);
  const client = createAdminClient();
  for (const [key, limit] of [[`ip:${ip}`, 50], [`${role}:account:${identifier}`, 5]] as const) {
    const { data, error } = await client.rpc("consume_auth_attempt", {
      p_key_hash: createHmac("sha256", secret).update(key).digest("hex"),
      p_limit: limit, p_window_seconds: 900,
    });
    if (error) throw new Error("Login throttling unavailable.");
    if (!data) throw new HttpError(429, "Too many login attempts. Try again later.");
  }
}
