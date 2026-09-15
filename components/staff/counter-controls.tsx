"use client";
import type { StaffQueueState } from "@/lib/staff/serving-types";

export function CounterControls({ state, disabled, pending, selectService, start, end }: {
  state: StaffQueueState; disabled: boolean; pending: string | null;
  selectService: (id: string) => void; start: (counterId: string) => void; end: () => void;
}) {
  const selection = state.assignments.find((a) => a.serviceId === state.selectedServiceId);
  const locations = [...new Map(state.assignments.map((a) => [a.locationId, a])).values()];
  const locked = disabled || Boolean(state.counterSession) || Boolean(state.serving) || state.servingAccessBlocked;
  return <section className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3" aria-label="Counter session">
    <form className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-4" onSubmit={(event) => {
      event.preventDefault(); start(String(new FormData(event.currentTarget).get("counterId") ?? ""));
    }}>
      <label>Location<select className="field" value={selection?.locationId ?? ""} disabled={locked || !locations.length} onChange={(event) => {
        const first = state.assignments.find((a) => a.locationId === event.target.value); if (first) selectService(first.serviceId);
      }}>{!locations.length && <option value="">No assigned locations</option>}{locations.map((a) => <option key={a.locationId} value={a.locationId}>{a.locationName}</option>)}</select></label>
      <label>Service<select className="field" value={state.selectedServiceId ?? ""} disabled={locked || !selection} onChange={(event) => selectService(event.target.value)}>
        {!selection && <option value="">No assigned services</option>}{state.assignments.filter((a) => a.locationId === selection?.locationId).map((a) => <option key={a.serviceId} value={a.serviceId}>{a.serviceName}</option>)}
      </select></label>
      {state.counterSession ? <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-teal-50 px-3 py-2">
        <div><p className="font-semibold text-teal-900">{state.counterSession.counterName}</p><p className="text-xs text-slate-600">{state.counterSession.operational ? "Counter session active" : "Counter access paused · ask your manager to check permissions"}</p></div>
        <button type="button" className="btn" disabled={disabled || Boolean(state.serving) || state.servingAccessBlocked} onClick={end}>{pending === "end-counter" ? "Ending…" : "End counter"}</button>
      </div> : <>
        <label>Available counter<select key={state.selectedServiceId} name="counterId" className="field" required defaultValue="" disabled={locked || !state.availableCounters.length}>
          <option value="" disabled>{state.availableCounters.length ? "Select a counter" : "No available counters"}</option>{state.availableCounters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <button className="btn btn-primary min-h-12" disabled={locked || !state.availableCounters.length} type="submit">{pending === "start-counter" ? "Starting…" : "Start serving"}</button>
      </>}
    </form>
    {!state.counterSession && !state.availableCounters.length && <p className="text-xs text-slate-500">No enabled counter is available at this location. Ask your manager or wait for one to be released.</p>}
  </section>;
}
