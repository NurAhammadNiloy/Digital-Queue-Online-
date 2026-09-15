import Link from "next/link";

export function Breadcrumbs({ section, href, current }: { section: string; href: string; current: string }) {
  return <nav aria-label="Breadcrumb" className="print:hidden"><ol className="flex flex-wrap items-center gap-2 text-sm"><li><Link href={href} className="underline">{section}</Link></li><li aria-hidden="true" className="text-slate-400">/</li><li aria-current="page" className="min-w-0 break-words text-slate-600">{current}</li></ol></nav>;
}
