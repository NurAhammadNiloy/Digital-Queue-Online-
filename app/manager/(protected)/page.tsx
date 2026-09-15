import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requirePageSession, sessionCookieName } from "@/lib/auth/session";
import Link from "next/link";
import { DashboardLocationFilter } from "@/components/manager/dashboard-location-filter";
import { LiveDashboardCounts } from "@/components/manager/dashboard-counts";
import { pageLocation, pageQuery } from "@/lib/manager/location-selection";
import { dashboard, locations } from "@/lib/manager/administration";
import { ConfigPanel } from "@/components/manager/config-panel";
import { managerAnalytics } from "@/lib/analytics/manager";
import { counterOperations } from "@/lib/counters/server";
import { StatusBadge } from "@/components/ui/status-badge";
import { Icon } from "@/components/ui/icon";

export default async function ManagerPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requirePageSession("manager");
  const query = pageQuery(await searchParams);
  const { options, selected } = await pageLocation(session, query);
  if (!selected) {
    if ((await locations(session, "archived")).length) redirect("/manager/locations?view=archived");
    return (
      <main className="page-narrow">
        <section className="card space-y-5" aria-labelledby="first-location-title">
          <span className="kpi-icon"><Icon name="location" /></span>
          <div className="space-y-2">
            <h1 id="first-location-title">Create your first location</h1>
            <p className="muted">Add a location to start serving customers with Digital Queue.</p>
          </div>
          <ConfigPanel kind="location" label="Create Location" primary />
        </section>
      </main>
    );
  }
  if (!query.has("locationId")) {
    const active = options.filter((location) => location.active);
    redirect(active.length === 1 ? `/manager/locations/${active[0].id}` : "/manager/locations");
  }
  const token = (await cookies()).get(sessionCookieName("manager"))!.value;
  const counts = await dashboard(token, selected.id);
  const [analytics, operations] = await Promise.all([
    managerAnalytics(token, selected.id, "today").catch(() => null),
    counterOperations(token, selected.id).catch(() => null),
  ]);
  return (
    <main className="page manager-report manager-dashboard manager-wide">
      <header className="flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow mb-1">Operations</p><h1>Dashboard</h1></div><DashboardLocationFilter locations={options} selectedId={selected.id} /></header>
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-4">
        <div><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg">{selected.name}</h2><StatusBadge active={selected.active} /></div><p className="mt-1 text-xs text-slate-500">{selected.timezone.replaceAll("_", " ")}</p></div>
        <nav aria-label="Location quick actions" className="flex flex-wrap gap-2"><Link href={`/manager/locations/${selected.id}`} className="btn btn-primary"><Icon name="location" />Manage location</Link><Link href={`/manager/analytics?locationId=${selected.id}`} className="btn"><Icon name="chart" />View analytics</Link><Link href={`/q/${selected.slug}`} className="btn" target="_blank" rel="noopener noreferrer">Open public queue<span className="sr-only"> (new tab)</span><Icon name="arrow" /></Link></nav>
      </section>
      <LiveDashboardCounts key={selected.id} locationId={selected.id} initial={counts} initialAnalytics={analytics ? { summary: analytics.summary, services: analytics.services } : null} initialOperations={operations} />
      <p className="text-xs text-slate-500">Updates automatically · Today uses the location’s local date. Averages use completed tickets; a dash means no data is available.</p>
    </main>
  );
}
