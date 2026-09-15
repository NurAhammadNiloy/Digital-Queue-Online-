export type LocationView = { id: string; name: string; slug: string; description: string | null; address: string | null; active: boolean; timezone: string; archived_at: string | null };
export type ServiceView = { id: string; name: string; queue_prefix: string; default_service_minutes: number; active: boolean; archived_at: string | null };
export type DashboardCounts = { waitingNow: number; currentlyServing: number; servedToday: number };
