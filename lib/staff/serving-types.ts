import type { StaffCounterState } from "@/lib/counters/types";
export type ServingAssignment = {
  locationId: string; locationName: string; locationTimezone: string; serviceId: string; serviceName: string;
};
export type ServingTicket = {
  id: string; queueNumber: string; customerName: string;
  locationId: string; serviceId: string; joinedAt: string; startedAt: string | null; counterName: string | null;
};
export type StaffQueueState = StaffCounterState & {
  staffName: string; assignments: ServingAssignment[]; selectedServiceId: string | null;
  waiting: ServingTicket[]; waitingTotal: number; page: number; pageSize: number;
  serving: ServingTicket | null; servingAccessBlocked: boolean;
};
