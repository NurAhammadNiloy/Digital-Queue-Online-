/** Missing/invalid estimates stay absent; never manufacture a display value. */
export function estimatedWaitLabel(minutes: number | null | undefined): string | null {
  if (typeof minutes !== "number" || !Number.isSafeInteger(minutes) || minutes < 0) return null;
  if (minutes === 0) return "You’re next";
  return `About ${minutes.toLocaleString("en-US")} min`;
}
