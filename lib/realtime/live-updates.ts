// Shared lifecycle for EventSource hints and polling. Hints never contain UI
// records: refresh must call the existing authorized read endpoint.
export function watchQueue(url: string | null, refresh: () => Promise<number | false | void>, pollMs: number) {
  let stopped = false, busy = false, dirty = false, accessLost = false;
  let source: EventSource | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined, debounce: ReturnType<typeof setTimeout> | undefined, reconnect: ReturnType<typeof setTimeout> | undefined;
  let retry = 4000, notBefore = 0;
  const visible = () => document.visibilityState !== "hidden";
  const disconnect = () => { if (source) { source.onmessage = null; source.onerror = null; source.close(); source = undefined; } };
  const schedule = () => {
    if (stopped) return;
    if (busy) { dirty = true; return; }
    if (!debounce) debounce = setTimeout(() => { debounce = undefined; void run(); }, Math.max(300, notBefore - Date.now()));
  };
  async function run() {
    if (stopped) return;
    if (busy) { dirty = true; return; }
    clearTimeout(poll);
    // A poll and a queued event hint can become due together. Consume both
    // with this read instead of leaving a second timer to issue a duplicate.
    clearTimeout(debounce); debounce = undefined;
    if (!visible() || Date.now() < notBefore) { poll = setTimeout(() => void run(), Math.max(pollMs, notBefore - Date.now())); return; }
    busy = true;
    let delay = pollMs;
    try {
      const result = await refresh();
      if (result === false) { stop(); return; }
      if (typeof result === "number") delay = Math.max(1000, result);
      notBefore = Date.now() + (delay > pollMs ? delay : 1000);
    } catch { delay = Math.max(pollMs, 10000); notBefore = Date.now() + delay; }
    finally {
      busy = false;
      if (!stopped) { poll = setTimeout(() => void run(), delay); if (dirty) { dirty = false; schedule(); } }
    }
  }
  function connect() {
    if (stopped || accessLost || !visible() || !url || source || typeof EventSource === "undefined") return;
    const current = new EventSource(url); source = current;
    const hint = () => { if (!stopped && source === current) schedule(); };
    current.addEventListener("queue-changed", hint);
    current.addEventListener("ready", () => { if (source === current) { retry = 4000; hint(); } });
    current.addEventListener("access-changed", () => {
      if (source !== current || stopped) return;
      accessLost = true; disconnect(); schedule();
    });
    current.onerror = () => {
      if (source !== current || stopped) return;
      disconnect();
      reconnect = setTimeout(connect, retry);
      retry = Math.min(30000, retry * 2);
    };
  }
  function visibility() {
    clearTimeout(reconnect);
    if (visible()) { connect(); schedule(); } else disconnect();
  }
  function stop() {
    if (stopped) return;
    stopped = true; disconnect(); clearTimeout(poll); clearTimeout(debounce); clearTimeout(reconnect);
    document.removeEventListener("visibilitychange", visibility);
  }
  document.addEventListener("visibilitychange", visibility);
  connect(); poll = setTimeout(() => void run(), pollMs);
  return stop;
}
