export type PublicLocation = {
  name: string; organizationName: string; slug: string;
  services: { id: string; name: string; code: string; waitingCount: number; estimatedWaitMinutes: number | null }[];
};
export type PublicTicket = {
  queueNumber: string; service: string; location: string; locationSlug: string; locationTimezone: string;
  status: "WAITING" | "SERVING" | "COMPLETED" | "SKIPPED" | "CANCELLED";
  joinedAt: string; calledAt: string | null; completedAt: string | null; skippedAt: string | null; cancelledAt: string | null;
  peopleAhead: number | null;
  estimatedWaitMinutes: number | null;
  estimatedCallAt: string | null;
  counterName: string | null;
};
