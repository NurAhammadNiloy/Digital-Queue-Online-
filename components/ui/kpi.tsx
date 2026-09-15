import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon";

export function Kpi({ label, value, icon = "clock", tone = "green" }: { label: string; value: ReactNode; icon?: IconName; tone?: "green" | "blue" | "amber" }) {
  return <div className="kpi" data-tone={tone}><dt className="mb-5 flex items-center justify-between gap-3"><span>{label}</span><span className="kpi-icon"><Icon name={icon} /></span></dt><dd>{value}</dd></div>;
}
