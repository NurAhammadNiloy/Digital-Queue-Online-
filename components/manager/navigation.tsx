"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/icon";

const links: [string, string, IconName][] = [["/manager", "Dashboard", "grid"], ["/manager/locations", "Locations", "location"], ["/manager/staff", "Staff", "people"], ["/manager/analytics", "Analytics", "chart"]];
export function ManagerNavigation() {
  const pathname = usePathname();
  return <nav aria-label="Manager navigation" className="manager-nav print:hidden">
    <div className="flex items-center gap-3"><span className="brand-mark"><Icon name="queue" /></span><div><p className="font-semibold text-white">Digital Queue</p><p className="text-xs text-emerald-100/70">Manager workspace</p></div></div>
    <p className="mt-10 hidden text-[10px] font-semibold tracking-widest text-emerald-100/60 uppercase lg:block">Workspace</p>
    <div className="manager-links">{links.map(([href, label, icon]) => <Link key={href} href={href} aria-current={(href === "/manager" ? pathname === href : pathname.startsWith(href)) ? "page" : undefined}><Icon name={icon} />{label}</Link>)}</div>
    <form action="/api/auth/logout?role=manager" method="post" className="mt-5 border-t border-white/15 pt-4 lg:mt-auto"><button type="submit" className="btn w-full"><Icon name="logout" />Log out</button></form>
  </nav>;
}
