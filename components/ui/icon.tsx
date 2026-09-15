import type { CSSProperties } from "react";

const paths = {
  queue: "M5 7h14M5 12h9M5 17h5M18 14v6m-3-3h6",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  location: "M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0ZM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2",
  check: "m5 12 4 4L19 6",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  logout: "M9 4H4v16h5M10 12h11m-4-4 4 4-4 4",
  chart: "M4 4v16h16M8 16v-5m5 5V7m5 9v-8",
  shield: "m12 3 8 3v5c0 5-8 10-8 10S4 16 4 11V6l8-3Zm-4 9 3 3 5-6",
  ticket: "M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4V5Zm12 3v2m0 4v2",
  pause: "M8 5v14M16 5v14",
} as const;

export type IconName = keyof typeof paths;
export function Icon({ name, className = "size-5", style }: { name: IconName; className?: string; style?: CSSProperties }) {
  return <svg aria-hidden="true" focusable="false" className={`shrink-0 ${className}`} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}

export function Avatar({ name }: { name: string }) {
  return <span aria-hidden="true" className="avatar">{name.trim().split(/\s+/).slice(0, 2).map((part) => [...part][0]).join("").toLocaleUpperCase()}</span>;
}
