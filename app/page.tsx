import Link from "next/link";
import { Icon } from "@/components/ui/icon";

export default function Home() {
  return (
    <div className="login-background flex min-h-svh items-center">
      <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-8 sm:py-20">
        <header className="mb-8 space-y-4 text-center sm:mb-10">
          <div className="brand justify-center">
            <span className="brand-mark"><Icon name="queue" /></span>
            <span>Digital Queue</span>
          </div>
          <h1 className="text-4xl sm:text-5xl">Welcome to Digital Queue</h1>
          <p className="mx-auto max-w-md text-base text-slate-600">
            Queue management for staff and administrators
          </p>
        </header>

        <div className="grid gap-4 sm:grid-cols-2 sm:gap-6">
          <section aria-labelledby="manager-title" className="card flex flex-col">
            <span className="kpi-icon mb-5"><Icon name="shield" /></span>
            <h2 id="manager-title" className="text-2xl">Management</h2>
            <p className="muted mt-2 mb-6 flex-1">
              Organization administration and location management
            </p>
            <Link href="/manager/login" className="btn btn-primary w-full">
              Management Login <Icon name="arrow" />
            </Link>
          </section>

          <section aria-labelledby="staff-title" className="card flex flex-col">
            <span className="kpi-icon mb-5"><Icon name="people" /></span>
            <h2 id="staff-title" className="text-2xl">Staff</h2>
            <p className="muted mt-2 mb-6 flex-1">
              Serve customers and manage your assigned queues
            </p>
            <Link href="/staff/login" className="btn btn-primary w-full">
              Staff Login <Icon name="arrow" />
            </Link>
          </section>
        </div>
      </main>
    </div>
  );
}
