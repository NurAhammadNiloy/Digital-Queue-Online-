"use client";

export default function DashboardError({ reset }: { reset: () => void }) {
  return <main className="customer-page">
    <h1 className="text-3xl font-semibold tracking-tight">Staff queue unavailable</h1>
    <p>Please try loading the queue again.</p>
    <button type="button" className="btn btn-primary" onClick={reset}>Retry</button>
    <form method="post" action="/api/auth/logout?role=staff"><button className="btn" type="submit">Log out</button></form>
  </main>;
}
