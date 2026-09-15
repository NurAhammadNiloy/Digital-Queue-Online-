import { isRandomToken } from "./input.ts";

export type JoinAttempt = { key: string; fingerprint: string; createdAt: number };
export const retryStorageKey = (slug: string) => `queue-join:${slug}`;

/** Store no name or ticket token. Unavailable storage falls back to the caller's ref. */
export async function prepareJoinAttempt(slug: string, name: string, serviceId: string, previous?: JoinAttempt) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([slug, serviceId, name])));
  const fingerprint = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  let saved = previous;
  if (!saved) {
    try { saved = JSON.parse(sessionStorage.getItem(retryStorageKey(slug)) ?? "null") as JoinAttempt | undefined; } catch {}
  }
  const now = Date.now();
  const attempt = saved && saved.fingerprint === fingerprint && typeof saved.key === "string" && isRandomToken(saved.key)
    && Number.isFinite(saved.createdAt) && saved.createdAt <= now && now - saved.createdAt < 86400000
    ? saved : { key: crypto.randomUUID(), fingerprint, createdAt: now };
  try { sessionStorage.setItem(retryStorageKey(slug), JSON.stringify(attempt)); } catch {}
  return attempt;
}
