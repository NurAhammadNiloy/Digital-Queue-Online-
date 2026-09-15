import "server-only";
import { notFound } from "next/navigation";
import { HttpError } from "@/lib/auth/http";
import type { ManagerSession } from "@/lib/auth/session";
import { locations, locationDetails } from "@/lib/manager/administration";
import { uuid } from "@/lib/staff/validation";

export function locationQuery(query: URLSearchParams, analytics = false) {
  if ([...query.keys()].some((key) => key !== "locationId" && !(analytics && key === "range")) || query.getAll("locationId").length > 1) throw new HttpError(400, "Invalid location selection.");
  const value = query.get("locationId");
  return value === null ? undefined : uuid(value);
}

export function requiredLocation(query: URLSearchParams, analytics = false) {
  const id = locationQuery(query, analytics);
  if (!id) throw new HttpError(400, "Select a location using locationId.");
  return id;
}

export function pageQuery(values: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, entry);
  return query;
}

export async function pageLocation(session: ManagerSession, query: URLSearchParams, analytics = false) {
  let id: string | undefined;
  try { id = locationQuery(query, analytics); } catch (error) { if (error instanceof HttpError) notFound(); throw error; }
  const options = await locations(session);
  // Historical analytics remain accessible from an archived location's manager
  // detail page, without putting archived locations in operational selectors.
  if (analytics && id && !options.some((location) => location.id === id)) {
    try { options.push(await locationDetails(session, id)); }
    catch (error) { if (error instanceof HttpError && error.status === 404) notFound(); throw error; }
  }
  const selected = id ? options.find((location) => location.id === id) : options[0];
  if (id && !selected) notFound();
  return { options, selected };
}
