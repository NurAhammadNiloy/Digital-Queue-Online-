export type AnalyticsRange = "today" | "7days" | "month" | "all";
export type ServiceAnalytics = { id: string; name: string; locationName: string; active: boolean; servedCount: number; averageWaitSeconds: number | null; averageServiceSeconds: number | null };
export type StaffAnalytics = { id: string; name: string; active: boolean; servedCount: number; averageServiceSeconds: number | null };
export type ManagerAnalytics = {
  range: AnalyticsRange;
  asOf: string;
  bucketUnit: "hour" | "day" | "month";
  servedOverTime: { start: string; servedCount: number }[];
  summary: { servedCount: number; servedToday: number; waitingNow: number; averageWaitSeconds: number | null; averageServiceSeconds: number | null };
  services: ServiceAnalytics[];
  staff: StaffAnalytics[];
};
