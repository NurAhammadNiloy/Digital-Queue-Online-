import "server-only";
import { isIP } from "node:net";

/** Only Vercel's overwritten header is trusted; other deployments share a bucket. */
export function trustedClientIp(headers: Pick<Headers, "get">) {
  const header = process.env.VERCEL === "1" ? headers.get("x-vercel-forwarded-for")?.trim() : null;
  return header && isIP(header) ? header : "shared-origin";
}
