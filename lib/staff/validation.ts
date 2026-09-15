import "server-only";
import { HttpError } from "@/lib/auth/http";
import { isValidPin } from "@/lib/auth/pin";
import { isValidStaffCode, normalizeStaffCode } from "@/lib/auth/staff-code";
import type { Assignment } from "@/lib/staff/types";

export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, "Invalid identifier.");
  }
  return value.toLowerCase();
}

export function pinInput(value: unknown): string {
  if (typeof value !== "string" || !isValidPin(value)) throw new HttpError(400, "PIN must contain 6–12 digits.");
  return value;
}

export function profileInput(body: Record<string, unknown>, creating: boolean) {
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 200) {
    throw new HttpError(400, "Name must contain 1–200 characters.");
  }
  if (body.staffCode !== undefined && typeof body.staffCode !== "string") throw new HttpError(400, "Invalid Staff ID.");
  const staffCode = normalizeStaffCode((body.staffCode as string | undefined) ?? "");
  if ((!creating || staffCode) && !isValidStaffCode(staffCode)) {
    throw new HttpError(400, "Staff ID must contain 3–32 letters, numbers, underscores or hyphens, starting with a letter or number.");
  }
  if (!Array.isArray(body.assignments) || body.assignments.length > 25) throw new HttpError(400, "Select up to 25 services.");
  const assignments: Assignment[] = body.assignments.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some((key) => !["locationId", "serviceId"].includes(key))) throw new HttpError(400, "Invalid assignment.");
    const pair = value as Record<string, unknown>;
    return { locationId: uuid(pair.locationId), serviceId: uuid(pair.serviceId) };
  });
  if (new Set(assignments.map((a) => a.serviceId)).size !== assignments.length) throw new HttpError(400, "Duplicate service assignment.");
  return { name: body.name.trim(), staffCode, assignments };
}
