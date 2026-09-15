"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LocationView } from "@/lib/manager/types";

export function DashboardLocationFilter({ locations, selectedId }: { locations: LocationView[]; selectedId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <div className="min-w-0 sm:w-80">
    <label className="block text-xs">Location
      <select className="field" value={selectedId} disabled={pending} onChange={(event) => {
        const id = event.target.value;
        startTransition(() => router.push(`/manager?locationId=${encodeURIComponent(id)}`));
      }}>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}{!location.active && " (inactive)"}</option>)}</select>
    </label>
    {pending && <span role="status" className="text-xs text-slate-500">Switching location…</span>}
  </div>;
}
