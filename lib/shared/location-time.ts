/** Format stored instants in the location's zone, independent of browser/server TZ. */
export function locationTime(value: string, timezone: string | undefined): string {
  if (!timezone) return "Time unavailable";
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(value));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
    return `${part("day")}/${part("month")}/${part("year")} · ${part("hour")}:${part("minute")}`;
  } catch { return "Time unavailable"; }
}
