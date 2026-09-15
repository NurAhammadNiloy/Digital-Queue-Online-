import Link from "next/link";
import { LifecycleTabs } from "@/components/manager/lifecycle-tabs";
import Image from "next/image";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { requirePageSession, sessionCookieName } from "@/lib/auth/session";
import { HttpError } from "@/lib/auth/http";
import { locationDetails, services } from "@/lib/manager/administration";
import { publicLocationUrl } from "@/lib/manager/qr";
import { ConfigPanel } from "@/components/manager/config-panel";
import { ServiceRow } from "@/components/manager/service-row";
import { Breadcrumbs } from "@/components/manager/breadcrumbs";
import { CopyButton } from "@/components/manager/copy-button";
import { PrintButton } from "@/components/manager/print-button";
import { StatusBadge } from "@/components/ui/status-badge";
import { LocationActions } from "@/components/manager/location-actions";
import { counterOperations } from "@/lib/counters/server";
import { LocationCounters } from "@/components/manager/location-counters";
export default async function LocationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ services?: string }> }) {
  const session = await requirePageSession("manager");
  if (session.role !== "manager") return null;
  const { id } = await params;
  const location = await locationDetails(session, id).catch((error: unknown) => {
    if (error instanceof HttpError && [400, 404].includes(error.status)) notFound();
    throw error;
  });
  const archivedServices = (await searchParams).services === "archived";
  const rows = await services(session, id, archivedServices), url = publicLocationUrl(location.slug);
  const counters = await counterOperations((await cookies()).get(sessionCookieName("manager"))!.value, id, true);
  return <main className="page">
    <Breadcrumbs section="Locations" href="/manager/locations" current={location.name} />
    <section className="card space-y-4 print:hidden" aria-label="Location summary">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-2"><h1>{location.name}</h1>{location.description && <p className="muted max-w-2xl whitespace-pre-wrap">{location.description}</p>}</div>{location.archived_at ? <span className="badge badge-inactive">Archived</span> : <StatusBadge active={location.active} />}</div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600">{location.address && <p>{location.address}</p>}<p>{location.timezone.replaceAll("_", " ")} · {rows.length} services</p></div>
      {!location.archived_at && <ConfigPanel key={JSON.stringify(location)} kind="location" location={location} label="Edit location" />}
      <LocationActions location={location} />
    </section>
    {!location.archived_at && <section className="card break-inside-avoid print:border-0 print:p-0" aria-label="Location QR code">
      <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center print:items-center print:text-center">
        <Image src={`/api/manager/locations/${id}/qr`} unoptimized width={160} height={160} alt={`QR code for ${location.name} public queue page`} className="h-40 w-40 shrink-0 rounded-xl border border-slate-200 bg-white p-2 print:h-[520px] print:w-[520px] print:max-h-[70vw] print:max-w-[70vw] print:border-0 print:p-4" />
        <div className="min-w-0 flex-1 space-y-3 print:flex print:flex-col print:items-center"><h2 className="print:text-3xl">Public queue</h2><p className="hidden print:block print:text-xl print:font-semibold">{location.name}</p><p className="break-all text-sm text-slate-600 print:max-w-xl">{url}</p>
          {!location.active && <p className="muted">The public queue is unavailable while this location is inactive.</p>}
          <div className="flex flex-wrap gap-2 print:hidden"><a className="btn" href={url} target="_blank" rel="noreferrer">Open queue page<span className="sr-only"> (new tab)</span></a><CopyButton value={url} /><a className="btn" href={`/api/manager/locations/${id}/qr?download=1`} download>Download</a><PrintButton /></div>
        </div>
      </div>
    </section>}
    {location.archived_at && <Link className="btn" href={`/manager/analytics?locationId=${id}`}>View historical analytics</Link>}
    <section className="space-y-4 print:hidden" aria-label="Services management"><div><h2>Services</h2><p className="muted mt-1">Manage queue settings and availability for this location.</p></div>
      <LifecycleTabs archived={archivedServices} activeHref={`/manager/locations/${id}`} archivedHref={`/manager/locations/${id}?services=archived`} label="Service views" />
      {!location.archived_at && !archivedServices && <ConfigPanel kind="service" locationId={id} label="Add service" primary />}
      {!rows.length && <p className="empty-state">No services in this view.</p>}
      <ul className="grid items-start gap-3 md:grid-cols-2">{rows.map((service) => <ServiceRow key={service.id} service={service} locationId={id} />)}</ul>
    </section>
    <LocationCounters key={id} locationId={id} initial={counters} parentArchived={Boolean(location.archived_at)} />
  </main>;
}
