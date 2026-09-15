import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import { watchQueue } from "../lib/realtime/live-updates.ts";

function browser(t) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document"), previousSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  const cleanups = [];
  const document = new EventTarget(); document.visibilityState = "visible";
  class Source extends EventTarget {
    static instances = [];
    constructor(url) { super(); this.url = url; this.closed = false; Source.instances.push(this); }
    close() { this.closed = true; }
    emit(name) { this.dispatchEvent(new Event(name)); }
    fail() { this.onerror?.(); }
  }
  Object.defineProperty(globalThis, "document", { value: document, configurable: true });
  Object.defineProperty(globalThis, "EventSource", { value: Source, configurable: true });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  t.after(() => {
    cleanups.forEach((stop) => stop());
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
    if (previousSource) Object.defineProperty(globalThis, "EventSource", previousSource); else delete globalThis.EventSource;
  });
  return { Source, document, watch: (...args) => { const stop = watchQueue(...args); cleanups.push(stop); return stop; }, tick: async (ms) => { t.mock.timers.tick(ms); await flush(); } };
}

test("realtime hints refresh before the fallback interval; event bursts are coalesced", async (t) => {
  const { Source, tick, watch } = browser(t); let reads = 0;
  const stop = watch("/api/staff/events?serviceId=A", async () => { reads++; }, 5000); t.after(stop);
  for (let i = 0; i < 100; i++) Source.instances[0].emit("queue-changed");
  await tick(300); assert.equal(reads, 1);
  for (let i = 0; i < 100; i++) Source.instances[0].emit("queue-changed");
  await tick(500); assert.equal(reads, 1);
  await tick(500); assert.equal(reads, 2);
});

test("polling still updates when realtime disconnects or EventSource is unavailable", async (t) => {
  const { Source, tick, watch } = browser(t); let reads = 0;
  const stop = watch("/api/manager/events?locationId=A", async () => { reads++; }, 5000); t.after(stop);
  Source.instances[0].fail(); assert.equal(Source.instances[0].closed, true);
  await tick(5000); assert.equal(reads, 1);
  await tick(5000); assert.equal(reads, 2);
  stop(); delete globalThis.EventSource;
  const fallback = watch("/api/staff/events?serviceId=A", async () => { reads++; }, 5000); t.after(fallback);
  await tick(5000); assert.equal(reads, 3);
});

test("switching locations closes the old source and ignores late Location A events", async (t) => {
  const { Source, tick, watch } = browser(t); const reads = [];
  const stopA = watch("/api/manager/events?locationId=A", async () => { reads.push("A"); }, 10000);
  const old = Source.instances[0]; stopA(); assert.ok(old.closed);
  const stopB = watch("/api/manager/events?locationId=B", async () => { reads.push("B"); }, 10000); t.after(stopB);
  old.emit("queue-changed"); Source.instances[1].emit("queue-changed"); await tick(300);
  assert.deepEqual(reads, ["B"]);
  stopB(); await tick(30000); assert.deepEqual(reads, ["B"]); assert.ok(Source.instances.every((source) => source.closed));
});

test("access removal closes the source, requests current authorization and cannot reconnect to the revoked scope", async (t) => {
  const { Source, tick, watch } = browser(t); let reads = 0;
  const stop = watch("/api/staff/events?serviceId=A", async () => { reads++; }, 5000); t.after(stop);
  const old = Source.instances[0]; old.emit("access-changed"); assert.ok(old.closed);
  await tick(300); assert.equal(reads, 1);
  old.emit("queue-changed"); await tick(5000); assert.equal(Source.instances.length, 1); assert.equal(reads, 2);
});

test("hidden tabs release listeners; becoming visible fetches a fresh snapshot", async (t) => {
  const { Source, document, tick, watch } = browser(t); let reads = 0;
  const stop = watch("/api/staff/events?serviceId=A", async () => { reads++; }, 5000); t.after(stop);
  document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange")); assert.ok(Source.instances[0].closed);
  await tick(5000); assert.equal(reads, 0);
  document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange")); await tick(300);
  assert.equal(Source.instances.length, 2); assert.equal(reads, 1);
});

test("overlapping hints never overlap reads; disposal during a read cannot restart timers", async (t) => {
  const { Source, tick, watch } = browser(t); let reads = 0, release;
  const stop = watch("/api/staff/events?serviceId=A", async () => { reads++; await new Promise((resolve) => { release = resolve; }); }, 5000); t.after(stop);
  Source.instances[0].emit("ready"); await tick(300); assert.equal(reads, 1);
  for (let i = 0; i < 20; i++) Source.instances[0].emit("queue-changed");
  await tick(5000); assert.equal(reads, 1);
  stop(); release(); await flush(); await tick(30000); assert.equal(reads, 1); assert.ok(Source.instances[0].closed);
});

test("terminal tickets stop all updates and Retry-After blocks event-triggered refresh storms", async (t) => {
  const { Source, tick, watch } = browser(t); let reads = 0;
  const stop = watch("/api/public/tickets/token/events", async () => { reads++; return reads === 1 ? 60000 : false; }, 10000); t.after(stop);
  Source.instances[0].emit("ready"); await tick(300); assert.equal(reads, 1);
  Source.instances[0].emit("queue-changed"); await tick(30000); assert.equal(reads, 1);
  await tick(30000); assert.equal(reads, 2); assert.ok(Source.instances[0].closed);
  await tick(100000); assert.equal(reads, 2);
});
