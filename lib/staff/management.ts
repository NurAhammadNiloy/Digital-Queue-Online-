import "server-only";
import type { NextRequest } from "next/server";
import { HttpError, readObjectBody, requireApiSession } from "@/lib/auth/http";
import { hashPin } from "@/lib/auth/pin";
import { sessionCookieName, tokenHash, type ManagerSession } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { pinInput, profileInput, uuid } from "@/lib/staff/validation";
import type { StaffOptions, StaffView } from "@/lib/staff/types";

const staffFields = "id,name,staff_code,active,archived_at,created_at,staff_assignments(location_id,service_id)" as const;

export async function managerSession(request: NextRequest) {
  const session = await requireApiSession(request, "manager");
  if (session.role !== "manager") throw new HttpError(403, "Access denied.");
  // None of these endpoints accept tenant overrides or other query parameters.
  if (request.nextUrl.searchParams.size) throw new HttpError(400, "Invalid request.");
  return session;
}

export async function listStaff(session: ManagerSession, id?: string, archived = false): Promise<StaffView[]> {
  let query = createAdminClient().from("staff").select(staffFields).eq("organization_id", session.organizationId).order("name").order("id");
  if (id) query = query.eq("id", uuid(id));
  else query = archived ? query.not("archived_at", "is", null) : query.is("archived_at", null);
  const { data, error } = await query;
  if (error) throw new Error("Staff lookup unavailable.");
  return data.map((staff) => ({
    id: staff.id, name: staff.name, staffCode: staff.staff_code, active: staff.active, archived: staff.archived_at !== null, createdAt: staff.created_at,
    assignments: staff.staff_assignments.map((a) => ({ locationId: a.location_id, serviceId: a.service_id })),
  }));
}

export async function getStaff(session: ManagerSession, id: string) {
  const staff = (await listStaff(session, id))[0];
  if (!staff) throw new HttpError(404, "Staff member not found.");
  return staff;
}

export async function staffOptions(session: ManagerSession): Promise<StaffOptions> {
  const client = createAdminClient();
  // Page both catalogs: PostgREST's default row cap must not hide a newly
  // created location or a service later in the organization's name order.
  const options: StaffOptions = { locations: [], services: [] };
  await Promise.all([
    (async () => {
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await client.from("locations").select("id,name,active").is("archived_at", null).eq("organization_id", session.organizationId).order("name").order("id").range(offset, offset + 499);
        if (error) throw new Error("Assignment lookup unavailable.");
        options.locations.push(...data);
        if (data.length < 500) break;
      }
    })(),
    (async () => {
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await client.from("services").select("id,location_id,name,active,locations!inner(archived_at)").is("archived_at", null).is("locations.archived_at", null).eq("organization_id", session.organizationId).order("name").order("id").range(offset, offset + 499);
        if (error) throw new Error("Assignment lookup unavailable.");
        options.services.push(...data.map((s) => ({ id: s.id, locationId: s.location_id, name: s.name, active: s.active })));
        if (data.length < 500) break;
      }
    })(),
  ]);
  return options;
}

type Operation = "create" | "update" | "reset-pin" | "set-active";
type Args = Database["public"]["Functions"]["manage_staff"]["Args"];

export async function mutateStaff(request: NextRequest, operation: Operation, id?: string) {
  const session = await managerSession(request);
  // Fail before expensive hashing for unknown or foreign targets; the transaction
  // independently revalidates membership, session, tenant and target under locks.
  if (operation !== "create" && (await getStaff(session, uuid(id))).archived) throw new HttpError(409, "Restore this staff member before editing.");
  const allowed = operation === "create" ? ["name", "staffCode", "pin", "assignments"] :
    operation === "update" ? ["name", "staffCode", "assignments"] : operation === "reset-pin" ? ["pin"] : ["active"];
  const body = await readObjectBody(request, allowed);
  const args: Args = { p_token_hash: tokenHash(request.cookies.get(sessionCookieName("manager"))!.value), p_operation: operation };
  if (id) args.p_staff_id = uuid(id);
  if (operation === "create" || operation === "update") {
    const profile = profileInput(body, operation === "create");
    args.p_name = profile.name;
    args.p_staff_code = profile.staffCode;
    args.p_assignments = profile.assignments;
  }
  if (operation === "create" || operation === "reset-pin") args.p_pin_hash = await hashPin(pinInput(body.pin));
  if (operation === "set-active") {
    if (typeof body.active !== "boolean") throw new HttpError(400, "Account status must be true or false.");
    args.p_active = body.active;
  }
  // An empty create code requests allocation inside the authorized database transaction.
  const { data, error } = await createAdminClient().rpc("manage_staff", args);
  if (!error && data) return { id: data };
  if (error?.code === "23505") {
    throw new HttpError(409, "Staff ID is unavailable. Choose another.");
  }
  if (error?.code === "42501") throw new HttpError(403, "Access or assignment is not permitted.");
  if (error?.code === "P0002") throw new HttpError(404, "Staff member not found.");
  if (["22023", "22P02", "23503", "23514"].includes(error?.code ?? "")) throw new HttpError(400, "Invalid staff details or assignments.");
  throw new Error("Staff update unavailable.");
}
