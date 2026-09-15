import { cookies } from "next/headers";
import { requirePageSession, sessionCookieName } from "@/lib/auth/session";
import { staffQueueState } from "@/lib/staff/serving";
import { ServingDashboard } from "@/components/staff/serving-dashboard";

export default async function StaffDashboardPage() {
  const session = await requirePageSession("staff");
  return <ServingDashboard initial={await staffQueueState(session, (await cookies()).get(sessionCookieName("staff"))!.value)} />;
}
