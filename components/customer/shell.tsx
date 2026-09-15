import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";

export function CustomerShell({ children }: { children: ReactNode }) {
  return <div className="customer-background">
    <div className="customer-brand"><div className="brand"><span className="brand-mark"><Icon name="queue" /></span>Digital Queue</div><span className="flex items-center gap-1.5 text-xs text-slate-600"><Icon name="shield" className="size-4" />Private &amp; secure</span></div>
    {children}
    <p className="mx-auto max-w-xl px-4 pb-8 text-center text-xs text-slate-500">Your visit, one step at a time.</p>
  </div>;
}
