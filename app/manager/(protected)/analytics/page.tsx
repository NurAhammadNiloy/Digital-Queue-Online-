import Link from "next/link";
import { LocationSelector } from "@/components/manager/location-selector";
import { pageLocation, pageQuery } from "@/lib/manager/location-selection";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { requirePageSession, sessionCookieName } from "@/lib/auth/session";
import { analyticsRange, analyticsRanges, duration } from "@/lib/analytics/filters";
import { managerAnalytics } from "@/lib/analytics/manager";
import { Kpi } from "@/components/ui/kpi";
import { AnalyticsCharts } from "@/components/manager/analytics-charts";
import { ClearHistory } from "@/components/manager/clear-history";

const cell = "px-3 py-3 text-left";
export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requirePageSession("manager");
  const query = pageQuery(await searchParams);
  const range = analyticsRange(query);
  if (!range) notFound();
  const { options, selected } = await pageLocation(session, query, true);
  if (!selected) return <main className="page"><h1 className="text-3xl font-semibold tracking-tight">Analytics</h1><p>No locations configured. Create a location to view its analytics.</p><Link href="/manager/locations" className="underline">Manage locations</Link></main>;
  const data = await managerAnalytics((await cookies()).get(sessionCookieName("manager"))!.value, selected.id, range);
  const label = analyticsRanges.find((item) => item.value === range)!.label;
  return <main className="page manager-report">
    <h1 className="text-3xl font-semibold tracking-tight">Analytics</h1>
    <form action="/manager/analytics" method="get" className="filter-bar report-filters">
      <LocationSelector locations={options} selectedId={selected.id} />
      <label className="block">Date range<select name="range" defaultValue={range} className="field">{analyticsRanges.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <button type="submit" className="btn btn-primary">Apply</button>
    </form>
    <p className="text-xs text-slate-500">{label} · Completed tickets in {selected.timezone}. Waiting now and served today show current counts.</p>
    <dl className="analytics-kpis grid gap-3 sm:grid-cols-6 xl:grid-cols-5">
      <Kpi label="Served in selected period" value={data.summary.servedCount} icon="check" />
      <Kpi label="Served today" value={data.summary.servedToday} icon="check" />
      <Kpi label="Waiting now" value={data.summary.waitingNow} icon="people" tone="amber" />
      <Kpi label="Average waiting time" value={duration(data.summary.averageWaitSeconds)} tone="amber" />
      <Kpi label="Average service duration" value={duration(data.summary.averageServiceSeconds)} tone="blue" />
    </dl>
    <AnalyticsCharts data={data} timezone={selected.timezone} locationName={selected.name} />
    <section className="space-y-3"><h2 className="text-xl font-semibold">By service</h2>
      <div className="table-card"><table className="responsive-table"><caption className="sr-only">Service totals for {label}</caption>
        <thead className="border-b"><tr>{["Service", "Served count", "Average wait", "Average service duration"].map((title) => <th scope="col" className={cell} key={title}>{title}</th>)}</tr></thead>
        <tbody>{data.services.map((service) => <tr key={service.id} className="border-b"><th scope="row" data-label="Service" className={cell}>{service.name}{!service.active && " (inactive)"}</th><td data-label="Served count" className={cell}>{service.servedCount}</td><td data-label="Average wait" className={cell}>{duration(service.averageWaitSeconds)}</td><td data-label="Average service duration" className={cell}>{duration(service.averageServiceSeconds)}</td></tr>)}
          {!data.services.length && <tr><td colSpan={4} className={cell}>No services yet.</td></tr>}</tbody>
      </table></div>
    </section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">Staff performance</h2>
      <div className="table-card"><table className="responsive-table"><caption className="sr-only">Staff totals for {label}</caption>
        <thead className="border-b"><tr>{["Staff member", "Served count", "Average service duration"].map((title) => <th scope="col" className={cell} key={title}>{title}</th>)}</tr></thead>
        <tbody>{data.staff.map((staff) => <tr key={staff.id} className="border-b"><th scope="row" data-label="Staff member" className={cell}>{staff.name}{!staff.active && " (inactive)"}</th><td data-label="Served count" className={cell}>{staff.servedCount}</td><td data-label="Average service duration" className={cell}>{duration(staff.averageServiceSeconds)}</td></tr>)}
          {!data.staff.length && <tr><td colSpan={3} className={cell}>No completed staff history in this period.</td></tr>}</tbody>
      </table></div>
    </section>
    <p className="muted">Wait = joined to called; service duration = called to completed. A dash means no completed-ticket data.</p>
    <ClearHistory key={selected.id} locationId={selected.id} locationName={selected.name} />
  </main>;
}
