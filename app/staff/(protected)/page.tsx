import Link from "next/link";
import { requirePageSession } from "@/lib/auth/session";

export default async function StaffPage() {
  const session = await requirePageSession("staff");
  return (
    <main className="customer-page">
      <div className="card space-y-5"><p className="eyebrow">Digital Queue · Staff workspace</p><h1 className="text-3xl font-semibold tracking-tight">Staff session</h1>
      <p>Signed in as {session.name}.</p>
      <p>{session.assignments.length} active service assignment(s).</p>
      <p><Link className="btn btn-primary" href="/staff/dashboard">Open serving dashboard</Link></p>
      <form action="/api/auth/logout?role=staff" method="post"><button className="btn" type="submit">Log out</button></form></div>
    </main>
  );
}
