import Link from "next/link";
export function LifecycleTabs({ archived, activeHref, archivedHref, label }: { archived: boolean; activeHref: string; archivedHref: string; label: string }) {
  return <nav className="flex flex-wrap gap-2" aria-label={label}><Link href={activeHref} className={`btn ${!archived ? "btn-primary" : ""}`} aria-current={!archived ? "page" : undefined}>Active</Link><Link href={archivedHref} className={`btn ${archived ? "btn-primary" : ""}`} aria-current={archived ? "page" : undefined}>Archived</Link></nav>;
}
