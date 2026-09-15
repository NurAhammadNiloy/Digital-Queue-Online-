import type { LocationView } from "@/lib/manager/types";

export function LocationSelector({ locations, selectedId }: { locations: LocationView[]; selectedId: string }) {
  return <label className="block">Location
    <select name="locationId" required defaultValue={selectedId} className="field">
      {locations.map((location) => <option key={location.id} value={location.id}>{location.name}{location.archived_at ? " (archived)" : !location.active ? " (inactive)" : ""}</option>)}
    </select>
  </label>;
}
