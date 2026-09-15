import { Breadcrumbs } from "@/components/manager/breadcrumbs";
import { requirePageSession } from "@/lib/auth/session";
import { staffOptions } from "@/lib/staff/management";
import { StaffProfileForm } from "@/components/manager/staff-forms";

export default async function NewStaffPage() {
  const session = await requirePageSession("manager");
  return <main className="page-narrow">
    <Breadcrumbs section="Staff" href="/manager/staff" current={"Create"} />
    <h1 className="text-3xl font-semibold tracking-tight">Create staff member</h1>
    <StaffProfileForm options={await staffOptions(session)} />
  </main>;
}
