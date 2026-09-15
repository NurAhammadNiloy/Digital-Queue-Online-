import { LifecycleActions } from "@/components/manager/lifecycle-actions";
import { Breadcrumbs } from "@/components/manager/breadcrumbs";
import { notFound } from "next/navigation";
import { requirePageSession } from "@/lib/auth/session";
import { HttpError } from "@/lib/auth/http";
import { getStaff, staffOptions } from "@/lib/staff/management";
import { StaffAccountForms, StaffProfileForm } from "@/components/manager/staff-forms";

export default async function EditStaffPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePageSession("manager");
  const { id } = await params;
  const staff = await getStaff(session, id).catch((error: unknown) => {
    if (error instanceof HttpError && [400, 404].includes(error.status)) notFound();
    throw error;
  });
  return <main className="page-narrow">
    <Breadcrumbs section="Staff" href="/manager/staff" current={staff.name} />
    <h1 className="text-3xl font-semibold tracking-tight">Manage {staff.name}</h1>
    {staff.archived ? <p className="empty-state">Archived · Restore, then activate and assign permissions explicitly.</p> : <><StaffProfileForm key={`${staff.name}:${staff.staffCode}:${JSON.stringify(staff.assignments)}`} staff={staff} options={await staffOptions(session)} />
    <StaffAccountForms staff={staff} /></>}
    <LifecycleActions kind="staff" id={id} name={staff.name} archived={staff.archived} returnTo="/manager/staff" />
  </main>;
}
