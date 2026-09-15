import "server-only";
import { createHmac } from "node:crypto";
import { HttpError } from "@/lib/auth/http";
import { trustedClientIp } from "@/lib/shared/request-ip";
import { createAdminClient } from "@/lib/supabase/admin";
import { databaseFailure } from "@/lib/shared/development-error";

export function customerDigest(value: string) {
  const secret = process.env.AUTH_RATE_LIMIT_SECRET;
  if (!secret || secret.length < 32) throw new Error("Rate-limit secret is required.");
  return createHmac("sha256", secret).update(value).digest("hex");
}

export async function consumePublicAttempt(headers: Pick<Headers, "get">, operation: "join" | "read" | "cancel") {
  const seconds = operation === "read" ? 60 : 900;
  const { data, error } = await createAdminClient().rpc("consume_auth_attempt", {
    p_key_hash: customerDigest(`public:${operation}:ip:${trustedClientIp(headers)}`),
    p_limit: operation === "read" ? 300 : 10, p_window_seconds: seconds,
  });
  if (error) throw databaseFailure("consume_auth_attempt", error);
  if (!data) throw new HttpError(429, "Too many requests. Please try again later.", seconds);
}
