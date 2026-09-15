export type StaffCounterState = {
  counterSession: { id: string; counterId: string; counterName: string; locationId: string; serviceId: string; startedAt: string; operational: boolean } | null;
  availableCounters: { id: string; name: string }[];
};
export type CounterOperations = {
  observedAt: string; locationTimezone: string;
  servingTickets: { needsRecovery: boolean; id: string; number: string; staffId: string; staffName: string; serviceName: string; counterName: string | null; startedAt: string }[];
  counters: { id: string; name: string; active: boolean; archived: boolean; ticketId: string | null; sessionId: string | null; lastSeenAt: string | null; ticketStartedAt: string | null; staffId: string | null; staffName: string | null;
    serviceName: string | null; operational: boolean; ticketNumber: string | null; startedAt: string | null }[];
  services: { id: string; name: string; active: boolean; archived: boolean; activeCounters: number; waiting: number; serving: number; servedToday: number }[];
};
