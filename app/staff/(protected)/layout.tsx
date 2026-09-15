import type { ReactNode } from "react";
import { requirePageSession } from "@/lib/auth/session";

export default async function StaffLayout({ children }: { children: ReactNode }) {
  await requirePageSession("staff");
  return children;
}
