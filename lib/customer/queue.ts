import "server-only";
import { createHash } from "node:crypto";
import { HttpError, readBody } from "@/lib/auth/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { canonicalCustomerName, isLocationSlug, isRandomToken, isUuid } from "@/lib/customer/input";
import type { PublicLocation, PublicTicket } from "@/lib/customer/types";
import { databaseFailure, logDevelopmentError } from "@/lib/shared/development-error";

export async function publicLocation(slug: string): Promise<PublicLocation> {
  if (!isLocationSlug(slug)) throw new HttpError(404, "Location unavailable.");
  const { data, error } = await createAdminClient().rpc("get_public_queue_location", { p_slug: slug });
  if (error) throw databaseFailure("get_public_queue_location", error);
  if (!data) throw new HttpError(404, "Location unavailable.");
  return data as PublicLocation;
}

export async function publicTicket(token: string, signal?: AbortSignal): Promise<PublicTicket> {
  if (!isRandomToken(token)) throw new HttpError(404, "Ticket not found.");
  const query = createAdminClient().rpc("get_public_queue_ticket", { p_token: token.toLowerCase() });
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  if (error) throw databaseFailure("get_public_queue_ticket", error);
  if (!data) throw new HttpError(404, "Ticket not found.");
  return data as PublicTicket;
}

export async function cancelTicket(request: Request, token: string): Promise<PublicTicket> {
  if (!isRandomToken(token)) throw new HttpError(404, "Ticket not found.");
  await readBody(request, []);
  const { data, error } = await createAdminClient().rpc("cancel_public_queue_ticket", { p_token: token.toLowerCase() });
  if (error?.code === "P0002") throw new HttpError(404, "Ticket not found.");
  if (error?.code === "P0001") throw new HttpError(409, "This ticket is no longer waiting and cannot be cancelled. Check its latest status below.");
  if (error) throw databaseFailure("cancel_public_queue_ticket", error);
  if (!data) throw new Error("Cancellation unavailable.");
  return data as PublicTicket;
}

export function rejectQuery(request: Request) {
  if (new URL(request.url).searchParams.size) throw new HttpError(400, "Invalid request.");
}

export async function joinQueue(request: Request, slug: string) {
  if (!isLocationSlug(slug)) throw new HttpError(404, "Location unavailable.");
  const key = request.headers.get("idempotency-key") ?? "";
  if (!isRandomToken(key)) throw new HttpError(400, "A random request key is required.");
  const body = await readBody(request, ["name", "serviceId"]);
  if (typeof body.name !== "string" || typeof body.serviceId !== "string" || !isUuid(body.serviceId)) throw new HttpError(400, "Invalid name or service.");
  let name: string;
  try { name = canonicalCustomerName(body.name); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Invalid name."); }
  const serviceId = body.serviceId.toLowerCase();
  const { data: token, error } = await createAdminClient().rpc("join_public_queue", {
    p_slug: slug, p_service_id: serviceId, p_customer_name: name,
    p_key_hash: createHash("sha256").update(key.toLowerCase()).digest("hex"),
    // The random request key salts this digest; rate-secret rotation cannot
    // invalidate a retry and names cannot be guessed from a DB-only digest.
    p_payload_hash: createHash("sha256").update(JSON.stringify([key.toLowerCase(), slug, serviceId, name])).digest("hex"),
  });
  if (error?.code === "P0001") throw new HttpError(409, "This request key was already used for different details.");
  if (error?.code === "P0002") throw new HttpError(404, "Location unavailable.");
  if (["22023", "22P02", "23514", "23503"].includes(error?.code ?? "")) throw new HttpError(400, "Selected service is unavailable or the request is invalid.");
  if (error) throw databaseFailure("join_public_queue", error);
  if (typeof token !== "string" || !isRandomToken(token)) throw new Error("Queue joining unavailable.");
  // Keep the existing success fields, but optional display metadata must never
  // discard the committed receipt. Bound the secondary read and return the
  // exact token from this request's idempotent RPC even if status/ETA fails.
  let ticket: PublicTicket | null = null;
  try { ticket = await publicTicket(token, AbortSignal.timeout(2000)); }
  catch (error) { logDevelopmentError(error, "api"); }
  return { token, statusUrl: `/ticket/${token}`, ticket };
}
