/** Keep name validation and retry fingerprints in the same canonical form. */
export function canonicalCustomerName(value: string) {
  if (value.length > 1024 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) throw new Error("Enter a name without control characters.");
  const name = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!name || [...name].length > 200) throw new Error("Name must contain 1–200 characters.");
  return name;
}
export const isUuid = (value: string) => value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const isRandomToken = (value: string) => isUuid(value) && value[14] === "4" && /^[89ab]$/i.test(value[19]);
export const isLocationSlug = (value: string) => value.length >= 1 && value.length <= 100 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) && !/\s/.test(value);
