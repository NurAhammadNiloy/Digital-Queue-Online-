"use client";
import { useId, useMemo, useState } from "react";

export function TimezoneSelect({ initial }: { initial?: string }) {
  const id = useId();
  // New forms mount only when opened in the browser; use the manager's local
  // zone as a suggested default. Existing locations always retain their value.
  const [selected, setSelected] = useState(() => initial ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
  const [search, setSearch] = useState("");
  const zones = useMemo(() => [...new Set(["UTC", selected, ...Intl.supportedValuesOf("timeZone")])].sort(), [selected]);
  const label = (zone: string) => zone.replaceAll("_", " ").replaceAll("/", " / ");
  const matches = zones.filter((zone) => label(zone).toLowerCase().includes(search.trim().toLowerCase()) || zone.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="space-y-3">
    <label className="block" htmlFor={`${id}-search`}>Find timezone<input id={`${id}-search`} type="search" className="field" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search city or region, e.g. Helsinki" autoComplete="off" /></label>
    <label className="block" htmlFor={id}>Location timezone<select id={id} name="timezone" className="field" value={selected} onChange={(event) => setSelected(event.target.value)} required aria-describedby={`${id}-help`}>
      {!matches.includes(selected) && <option value={selected}>{label(selected)} (selected)</option>}
      {matches.map((zone) => <option key={zone} value={zone}>{label(zone)}</option>)}
    </select></label>
    {!matches.length && <p className="muted">No matches. Your selected timezone is unchanged.</p>}
    <p id={`${id}-help`} className="muted">{initial ? "" : "Defaults to your browser’s timezone; choose the location’s timezone if different. "}Used for local timestamps and queue dates.</p>
  </div>;
}
