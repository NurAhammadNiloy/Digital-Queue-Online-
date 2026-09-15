import "server-only";
import type { NextRequest } from "next/server";
import { HttpError, readBody, requireApiSession } from "@/lib/auth/http";
import { sessionCookieName, tokenHash } from "@/lib/auth/session";
import { uuid } from "@/lib/staff/validation";
import { createAdminClient } from "@/lib/supabase/admin";

export async function entityLifecycle(request: NextRequest, kind: string, id: string, preview = false) {
  await requireApiSession(request, "manager");
  if (request.nextUrl.searchParams.size || !["staff", "services", "counters", "locations"].includes(kind)) throw new HttpError(400, "Invalid lifecycle request.");
  const args = { p_token_hash: tokenHash(request.cookies.get(sessionCookieName("manager"))!.value), p_kind: kind, p_id: uuid(id) };
  const body = preview ? null : await readBody(request, ["action"]);
  if (body && !["archive", "permanent-delete", "restore"].includes(body.action)) throw new HttpError(400, "Invalid lifecycle action.");
  const result = preview ? await createAdminClient().rpc("preview_manager_lifecycle", args)
    : await createAdminClient().rpc("manage_entity_lifecycle", { ...args, p_action: body!.action });
  if (result.error?.code === "42501") throw new HttpError(403, "Access denied.");
  if (result.error?.code === "P0002") throw new HttpError(404, "Record not found.");
  if (["55P03", "40P01", "40001"].includes(result.error?.code ?? "")) throw new HttpError(409, "A related operation is in progress. Refresh and try again when it finishes.");
  if (result.error?.code === "23503") throw new HttpError(409, "This record now has dependencies. Choose Delete again to review archiving instead.");
  if (result.error?.code === "23514") throw new HttpError(409, result.error.message === "Restore parent location first"
    ? "Restore the parent location first. This record will remain inactive when restored."
    : "Resolve waiting/serving tickets and end active counter sessions first, then refresh and try again.");
  if (result.error?.code === "22023") throw new HttpError(400, "Invalid lifecycle action.");
  if (result.error || !result.data) throw new Error("Lifecycle operation unavailable.");
  return result.data;
}
