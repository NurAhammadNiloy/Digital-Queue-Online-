import "server-only";
import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { HttpError, readObjectBody } from "@/lib/auth/http";
import { sessionCookieName, tokenHash, type ManagerSession } from "@/lib/auth/session";
import { managerSession } from "@/lib/staff/management";
import { uuid } from "@/lib/staff/validation";
import { createAdminClient } from "@/lib/supabase/admin";
import { configInput } from "@/lib/manager/validation";
import type { DashboardCounts, LocationView, ServiceView } from "@/lib/manager/types";

const fields = "id,name,slug,description,address,active,timezone,archived_at";
export async function locations(session: ManagerSession, view: "active" | "archived" | "all" = "active"): Promise<LocationView[]> {
  const all: LocationView[] = [];
  for (let offset = 0; ; offset += 500) {
    let query = createAdminClient().from("locations").select(fields).eq("organization_id", session.organizationId).order("name").order("id").range(offset, offset + 499);
    if (view !== "all") query = view === "archived" ? query.not("archived_at", "is", null) : query.is("archived_at", null);
    const { data, error } = await query;
    if (error) throw new Error("Location lookup unavailable.");
    all.push(...data);
    if (data.length < 500) return all;
  }
}
export async function locationDetails(session: ManagerSession, id: string): Promise<LocationView> {
  const { data, error } = await createAdminClient().from("locations").select(fields).eq("organization_id", session.organizationId).eq("id", uuid(id)).maybeSingle();
  if (error) throw new Error("Location lookup unavailable.");
  if (!data) throw new HttpError(404, "Location not found.");
  return data;
}
export async function services(session: ManagerSession, locationId: string, archived = false): Promise<ServiceView[]> {
  await locationDetails(session, locationId);
  const all: ServiceView[] = [];
  for (let offset = 0; ; offset += 500) {
    let query = createAdminClient().from("services").select("id,name,queue_prefix,default_service_minutes,active,archived_at").eq("organization_id", session.organizationId).eq("location_id", locationId).order("name").order("id").range(offset, offset + 499);
    query = archived ? query.not("archived_at", "is", null) : query.is("archived_at", null);
    const { data, error } = await query;
    if (error) throw new Error("Service lookup unavailable.");
    all.push(...data);
    if (data.length < 500) return all;
  }
}
export async function dashboard(token: string, locationId: string): Promise<DashboardCounts> {
  const { data, error } = await createAdminClient().rpc("get_manager_dashboard", { p_token_hash: tokenHash(token), p_location_id: uuid(locationId) });
  if (error?.code === "P0002") throw new HttpError(404, "Location not found.");
  if (error?.code === "42501") throw new HttpError(403, "Access denied.");
  if (error || !data || typeof data !== "object" || Array.isArray(data)) throw new Error("Dashboard unavailable.");
  const keys = ["waitingNow", "currentlyServing", "servedToday"] as const;
  const result = {} as DashboardCounts;
  for (const key of keys) {
    const value = data[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid dashboard response.");
    result[key] = value;
  }
  return result;
}
type Operation = "create-location" | "update-location" | "create-service" | "update-service";
export async function mutateConfig(request: NextRequest, operation: Operation, locationId?: string, serviceId?: string) {
  const session = await managerSession(request);
  if (locationId && (await locationDetails(session, uuid(locationId))).archived_at) throw new HttpError(409, "Restore this location before editing.");
  if (serviceId) uuid(serviceId);
  const isLocation = operation.endsWith("location");
  const body = await readObjectBody(request, isLocation ? ["name", "description", "address", "active", "timezone"] : ["name", "queuePrefix", "defaultServiceMinutes", "active"]);
  // Details-only saves must not restore a stale Active value after a separate
  // lifecycle action. The RPC preserves active when omitted on an edit.
  const preserveActive = operation === "update-location" && body.active === undefined;
  const values: { name: string; active?: boolean; [key: string]: string | number | boolean | null | undefined } = configInput(preserveActive ? { ...body, active: true } : body, isLocation);
  if (preserveActive) delete values.active;
  for (let attempt = 0; attempt < 3; attempt++) {
    const slugBase = values.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 70).replace(/^-+|-+$/g, "") || "location";
    const { data, error } = await createAdminClient().rpc("manage_location_config", {
      p_token_hash: tokenHash(request.cookies.get(sessionCookieName("manager"))!.value), p_operation: operation,
      ...(locationId ? { p_location_id: locationId } : {}), ...(serviceId ? { p_service_id: serviceId } : {}),
      p_values: operation === "create-location" ? { ...values, slug: `${slugBase}-${randomBytes(8).toString("hex")}` } : values,
    });
    if (!error && data) return { id: data };
    if (error?.code === "23505") {
      if (operation === "create-location" && attempt < 2) continue;
      throw new HttpError(409, isLocation ? "Location URL is unavailable. Try again." : "Service name or queue prefix already exists at this location.");
    }
    if (error?.code === "42501") throw new HttpError(403, "Access denied.");
    if (error?.code === "P0002") throw new HttpError(404, "Location or service not found.");
    if (["22023", "22P02", "22003", "23503", "23514"].includes(error?.code ?? "")) throw new HttpError(400, "Invalid location or service details.");
    throw new Error("Configuration update unavailable.");
  }
  throw new Error("Location creation unavailable.");
}

export async function mutateLocationLifecycle(request: NextRequest, id: string, deleting = false) {
  await managerSession(request);
  const body = await readObjectBody(request, deleting ? [] : ["action"]);
  if (!deleting && body.action !== "activate" && body.action !== "deactivate") throw new HttpError(400, "Invalid location action.");
  const { data, error } = await createAdminClient().rpc("manage_location_config", {
    p_token_hash: tokenHash(request.cookies.get(sessionCookieName("manager"))!.value),
    p_operation: deleting ? "delete-location" : `${body.action}-location`, p_location_id: uuid(id), p_values: {},
  });
  if (error?.code === "42501") throw new HttpError(403, "Access denied.");
  if (error?.code === "P0002") throw new HttpError(404, "Location not found.");
  if (error?.code === "23503") throw new HttpError(409, "This location has services or other dependent data. Deactivate it instead to preserve its history.");
  if (error?.code === "22023") throw new HttpError(400, "Invalid location action.");
  if (error || !data) throw new Error("Location action unavailable.");
  return { id: data };
}
