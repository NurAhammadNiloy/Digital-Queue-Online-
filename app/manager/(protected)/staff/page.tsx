import { LifecycleActions } from "@/components/manager/lifecycle-actions";
import { LifecycleTabs } from "@/components/manager/lifecycle-tabs";
import Link from "next/link";
import { requirePageSession } from "@/lib/auth/session";
import { listStaff, staffOptions } from "@/lib/staff/management";
import { StatusBadge } from "@/components/ui/status-badge";
import { Avatar } from "@/components/ui/icon";

export default async function StaffListPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const session = await requirePageSession("manager");
  const archived = (await searchParams).view === "archived";
  const [staff, options] = await Promise.all([listStaff(session, undefined, archived), staffOptions(session)]);
  return <main className="page">
    <header className="flex flex-wrap items-center justify-between gap-4"><div className="space-y-2"><h1>Staff members</h1><p className="muted">Manage staff access and service permissions.</p></div>{!archived && <Link href="/manager/staff/new" className="btn btn-primary">Create staff member</Link>}</header>
    <LifecycleTabs archived={archived} activeHref="/manager/staff" archivedHref="/manager/staff?view=archived" label="Staff views" />
    {!staff.length ? <p className="empty-state">No staff members in this view.</p> : <ul className="grid gap-4 md:grid-cols-2">
      {staff.map((person) => <li key={person.id} className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-3"><Avatar name={person.name} /><div className="min-w-0 flex-1"><h2 className="text-base">{person.name}</h2><p className="mt-1 text-xs text-slate-600">Staff ID <span className="font-mono font-semibold">{person.staffCode}</span></p></div>{person.archived ? <span className="badge badge-inactive">Archived</span> : <StatusBadge active={person.active} />}</div>
        <p className="text-xs font-medium text-slate-500">{new Set(person.assignments.map((a) => a.locationId)).size} locations · {person.assignments.length} service permissions</p>
        <div className="space-y-3">{options.locations.filter((location) => person.assignments.some((a) => a.locationId === location.id)).map((location) => <div key={location.id}><h3 className="text-sm">{location.name}{!location.active && <span className="ml-2 text-xs font-normal text-slate-500">Inactive</span>}</h3><div className="mt-2 flex flex-wrap gap-1.5">{person.assignments.filter((a) => a.locationId === location.id).map((assignment) => { const service = options.services.find((s) => s.id === assignment.serviceId); return <span key={assignment.serviceId} className="badge badge-inactive">{service?.name ?? "Service unavailable"}{service && !service.active && " · Inactive"}</span>; })}</div></div>)}</div>
        {!person.assignments.length && <p className="muted">No service permissions assigned.</p>}
        <Link href={`/manager/staff/${person.id}`} className="btn">Manage<span className="sr-only"> {person.name}</span></Link>
        <LifecycleActions kind="staff" id={person.id} name={person.name} archived={person.archived} />
      </li>)}
    </ul>}
  </main>;
}
