import { HttpError } from "../auth/http";

function text(value: unknown, label: string, max: number, optional = false): string {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string") throw new HttpError(400, `Invalid ${label}.`);
  const result = value.normalize("NFC").trim();
  if ((!optional && !result) || [...result].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) throw new HttpError(400, `Invalid ${label}.`);
  return result;
}

export function configInput(body: Record<string, unknown>, location: boolean) {
  const name = text(body.name, "name", 200);
  if (typeof body.active !== "boolean") throw new HttpError(400, "Active must be true or false.");
  if (location) {
    const timezone = body.timezone === undefined ? undefined : text(body.timezone, "IANA timezone", 100);
    if (timezone !== undefined) {
      try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
      catch { throw new HttpError(400, "Enter a valid IANA timezone, such as Europe/Helsinki."); }
    }
    return { name, active: body.active, description: text(body.description, "description", 2000, true) || null, address: text(body.address, "address", 500, true) || null, ...(timezone === undefined ? {} : { timezone }) };
  }
  const queuePrefix = text(body.queuePrefix, "queue prefix", 4).toUpperCase();
  if (!/^[A-Z]{1,4}$/.test(queuePrefix)) throw new HttpError(400, "Queue prefix must contain 1–4 letters.");
  const minutes = body.defaultServiceMinutes;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 2147483647) throw new HttpError(400, "Service minutes must be a positive whole number.");
  return { name, active: body.active, queuePrefix, defaultServiceMinutes: minutes };
}
