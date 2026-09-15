import type { ReactNode } from "react";
import { ManagerNavigation } from "@/components/manager/navigation";
import { Avatar, Icon } from "@/components/ui/icon";
import { requirePageSession } from "@/lib/auth/session";

export default async function ManagerLayout({ children }: { children: ReactNode }) {
  const session = await requirePageSession("manager");
  return <div className="manager-shell">
    <a href="#manager-content" className="skip-link print:hidden">Skip to content</a>
    <ManagerNavigation />
    <div id="manager-content" tabIndex={-1} className="min-w-0"><header className="manager-topbar print:hidden"><span className="flex items-center gap-2 text-xs font-medium text-slate-500"><Icon name="shield" className="size-4" />Organization workspace</span><div className="flex min-w-0 items-center gap-3"><span className="max-w-48 truncate text-sm font-medium">{session.name}</span><Avatar name={session.name} /></div></header>{children}</div>
  </div>;
}
