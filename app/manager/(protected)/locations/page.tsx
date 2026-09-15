import { LifecycleActions } from "@/components/manager/lifecycle-actions";
import { LifecycleTabs } from "@/components/manager/lifecycle-tabs";
import Link from "next/link";
import { requirePageSession } from "@/lib/auth/session";
import { locations } from "@/lib/manager/administration";
import { ConfigPanel } from "@/components/manager/config-panel";
import { StatusBadge } from "@/components/ui/status-badge";
import { Icon } from "@/components/ui/icon";
export default async function LocationsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const session = await requirePageSession("manager");
  if (session.role !== "manager") return null;
  const archived = (await searchParams).view === "archived";
  const rows = await locations(session, archived ? "archived" : "active");
  return <main className="page manager-wide">
    <header className="space-y-2"><h1>Locations</h1><p className="muted">Manage public queue pages, services and local settings.</p></header>
    <LifecycleTabs archived={archived} activeHref="/manager/locations" archivedHref="/manager/locations?view=archived" label="Location views" />
    {!archived && <ConfigPanel kind="location" label="Create location" primary />}
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{rows.map((location) => <li key={location.id} className="flex min-w-0 flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
      <div className="flex items-center justify-between gap-3"><span className="kpi-icon"><Icon name="location" /></span>{archived ? <span className="badge badge-inactive">Archived</span> : <StatusBadge active={location.active} />}</div>
      <div className="min-w-0"><h2 className="text-lg">{location.name}</h2>{location.address && <p className="mt-1 text-sm text-slate-600">{location.address}</p>}<p className="mt-2 flex items-start gap-2 text-xs text-slate-500"><Icon name="clock" className="size-4" /><span>{location.timezone.replaceAll("_", " ")}</span></p></div>
      <div className="mt-auto flex flex-wrap gap-2 border-t border-slate-100 pt-4"><Link className="btn btn-primary flex-1" href={`/manager/locations/${location.id}`}>Manage<span className="sr-only"> {location.name}</span><Icon name="arrow" /></Link>{!archived && <Link className="btn flex-1" href={`/q/${location.slug}`} target="_blank" rel="noopener noreferrer">Open queue<span className="sr-only"> for {location.name} (new tab)</span></Link>}</div>
      <LifecycleActions kind="locations" id={location.id} name={location.name} archived={archived} />
    </li>)}</ul>
    {!rows.length && <p className="empty-state">No locations in this view.</p>}
  </main>;
}
