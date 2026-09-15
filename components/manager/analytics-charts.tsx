import type { ManagerAnalytics } from "@/lib/analytics/types";

export function AnalyticsCharts({ data, timezone, locationName }: { data: ManagerAnalytics; timezone: string; locationName: string }) {
  const series = data.servedOverTime;
  const hasData = series.some((row) => row.servedCount > 0);
  const max = Math.max(1, ...series.map((row) => row.servedCount));
  const ceiling = Math.ceil(max / 4) * 4;
  const x = (index: number) => series.length < 2 ? 316 : 48 + index / (series.length - 1) * 532;
  const y = (value: number) => 182 - value / ceiling * 156;
  const format = (start: string, full = false) => new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    ...(data.bucketUnit === "hour" ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const, ...(full ? { timeZoneName: "shortOffset" as const } : {}) }
      : data.bucketUnit === "day" ? { day: "2-digit", month: "short", ...(full ? { year: "numeric" as const } : {}) }
        : { month: "short", year: "numeric" }),
  }).format(new Date(start));
  const tickIndexes = [...new Set([0, Math.round((series.length - 1) / 2), series.length - 1])].filter((index) => index >= 0);
  const services = [...data.services].sort((a, b) => b.servedCount - a.servedCount || a.name.localeCompare(b.name));
  const serviceMax = Math.max(1, ...services.map((service) => service.servedCount));
  return <div className="grid items-start gap-4 lg:grid-cols-2">
    <section className="card analytics-chart space-y-3" aria-label="Served customers over time">
      <h2>Served customers over time</h2>
      <p className="muted">{data.bucketUnit === "hour" ? "Hourly" : data.bucketUnit === "day" ? "Daily" : "Monthly"} completions · {timezone}. Current bucket is partial.</p>
      {!hasData ? <p className="empty-state">No customers completed service in this period.</p> : <>
        <svg viewBox="0 0 620 224" role="img" aria-label={`Completed customers over time at ${locationName}. Exact counts are available below.`} className="block h-auto w-full overflow-visible">
          <title>Served customers over time</title>
          {[0, 1, 2, 3, 4].map((tick) => <g key={tick}><line x1="48" x2="580" y1={y(ceiling * tick / 4)} y2={y(ceiling * tick / 4)} stroke="#e2e8e3" /><text x="38" y={y(ceiling * tick / 4) + 6} textAnchor="end" fontSize="18" fill="#64748b">{new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 }).format(ceiling * tick / 4)}</text></g>)}
          <polyline points={series.map((row, index) => `${x(index)},${y(row.servedCount)}`).join(" ")} fill="none" stroke="#28634c" strokeWidth="3" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          {series.map((row, index) => <circle key={row.start} cx={x(index)} cy={y(row.servedCount)} r={series.length > 60 ? 2 : 4} fill="#28634c"><title>{`${format(row.start, true)}: ${row.servedCount} served`}</title></circle>)}
          {tickIndexes.map((index) => <text key={index} x={x(index)} y="214" textAnchor={series.length === 1 ? "middle" : index === 0 ? "start" : index === series.length - 1 ? "end" : "middle"} fontSize="18" fill="#64748b">{format(series[index].start)}</text>)}
        </svg>
        <details><summary className="cursor-pointer rounded py-2 text-sm font-medium text-teal-800 underline underline-offset-4">View exact counts</summary><div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-slate-200"><table><caption className="sr-only">Completed customers per {data.bucketUnit} at {locationName}</caption><thead><tr><th scope="col">{data.bucketUnit === "hour" ? "Hour (local time)" : "Period"}</th><th scope="col">Served</th></tr></thead><tbody>{series.map((row) => <tr key={row.start}><th scope="row">{format(row.start, true)}</th><td>{row.servedCount}</td></tr>)}</tbody></table></div></details>
      </>}
    </section>
    <section className="card analytics-chart space-y-3" aria-label="Service performance chart">
      <h2>Service performance</h2><p className="muted">Completed customers by service · selected period</p>
      {!services.some((row) => row.servedCount > 0) ? <p className="empty-state">No completed service activity in this period.</p> : <ul className="max-h-96 space-y-4 overflow-y-auto pr-1">{services.map((service) => <li key={service.id}><div className="mb-1.5 flex items-start justify-between gap-3 text-sm"><span className="min-w-0 break-words font-medium">{service.name}{!service.active && <span className="text-xs font-normal text-slate-500"> · Inactive</span>}</span><span className="shrink-0 font-semibold tabular-nums">{service.servedCount}<span className="sr-only"> served</span></span></div><div className="h-3 overflow-hidden rounded bg-slate-100" aria-hidden="true"><div className="h-full rounded bg-teal-800" style={{ width: `${service.servedCount / serviceMax * 100}%` }} /></div></li>)}</ul>}
    </section>
  </div>;
}
