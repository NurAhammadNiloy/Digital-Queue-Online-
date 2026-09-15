import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { hashPin } from "../lib/auth/pin.ts";

const origin = "http://127.0.0.1:3110";
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
function sql(statement) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_digital-queue-management-system", "psql", "-X", "-qAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
async function eventually(check, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(50); }
  assert.fail(label);
}

test("real Supabase Broadcast -> authorized streams -> queue refresh", { timeout: 180000 }, async (t) => {
  const cfg = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "exec", "--yes", "--package=supabase@2.117.0", "--", "supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(new URL(cfg.API_URL).hostname, "127.0.0.1", "Local fixtures only");
  const admin = createClient(cfg.API_URL, cfg.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const f = Object.fromEntries(["org", "foreignOrg", "a", "b", "foreignLoc", "sa", "sb", "staff"].map((key) => [key, randomUUID()]));
  const tag = randomBytes(6).toString("hex"), code = `LIVE_${tag.toUpperCase()}`, email = `live-${tag}@example.invalid`, password = randomBytes(32).toString("base64url"), pin = "482937", hash = await hashPin(pin), secret = randomBytes(32).toString("hex");
  const keys = new Set(["ip:shared-origin", "public:join:ip:shared-origin", "public:read:ip:shared-origin", `manager:account:${email}`, `staff:account:${code}`, `realtime:staff:${f.staff}`]);
  const streams = []; let server, user, staffCookie, managerCookie, aEvents, bEvents, staffEvents, first, second;
  async function req(path, { body, cookie, headers = {} } = {}) {
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) { headers.origin = origin; headers["content-type"] = "application/json"; }
    const r = await fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: "manual" });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = null; }
    return { status: r.status, data, text, cookie: r.headers.getSetCookie()[0]?.split(";")[0] };
  }
  async function events(path, cookie) {
    const controller = new AbortController();
    const r = await fetch(`${origin}${path}`, { headers: { ...(cookie ? { cookie } : {}), origin, "sec-fetch-site": "same-origin" }, signal: controller.signal });
    assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/event-stream/); assert.match(r.headers.get("cache-control"), /no-store/);
    const state = { events: [], text: "", closed: false, close: () => controller.abort() }; streams.push(state);
    const reader = r.body.getReader(), decoder = new TextDecoder();
    state.done = (async () => {
      let buffered = "";
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; const text = decoder.decode(value, { stream: true }); state.text += text; buffered += text;
          const parts = buffered.split("\n\n"); buffered = parts.pop();
          for (const part of parts) { const match = part.match(/^event: (.+)$/m); if (match) state.events.push(match[1]); }
        }
      } catch { /* Explicit cancellation also reaches here. */ }
      finally { state.closed = true; reader.releaseLock(); }
    })();
    await eventually(() => state.events.includes("ready"), "Supabase private Broadcast must actually subscribe (polling is not a substitute)");
    return state;
  }
  const count = (stream) => stream.events.filter((event) => event === "queue-changed").length;
  async function changed(stream, action) { const before = count(stream); const result = await action(); await eventually(() => count(stream) > before, "Queue mutation did not produce a realtime signal"); return result; }
  const join = (name, location = f.a, service = f.sa) => req(`/api/public/locations/live-${location === f.a ? "a" : "b"}-${tag}/tickets`, { body: { name, serviceId: service }, headers: { "idempotency-key": randomUUID() } });
  const action = (name, body) => req(`/api/staff/queue/${name}`, { cookie: staffCookie, body });
  const ticket = (token) => req(`/api/public/tickets/${token}`);
  const counts = (location) => req(`/api/manager/dashboard?locationId=${location}`, { cookie: managerCookie });
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true }); assert.equal(created.error, null); user = created.data.user.id; keys.add(`realtime:manager:${user}`);
    sql(`insert into public.organizations(id,name) values ('${f.org}','Realtime fixture'),('${f.foreignOrg}','Foreign fixture');
      insert into public.managers(user_id,organization_id,name) values ('${user}','${f.org}','Live manager');
      insert into public.locations(id,organization_id,name,slug) values ('${f.a}','${f.org}','Live A','live-a-${tag}'),('${f.b}','${f.org}','Live B','live-b-${tag}'),('${f.foreignLoc}','${f.foreignOrg}','Foreign','live-foreign-${tag}');
      insert into public.services(id,organization_id,location_id,name,queue_prefix,default_service_minutes) values ('${f.sa}','${f.org}','${f.a}','Service A','A',5),('${f.sb}','${f.org}','${f.b}','Service B','B',5);
      insert into public.staff(id,organization_id,name,staff_code,pin_hash) values ('${f.staff}','${f.org}','Live staff','${code}',${literal(hash)});
      insert into public.staff_assignments(organization_id,staff_id,location_id,service_id) values ('${f.org}','${f.staff}','${f.a}','${f.sa}');`);
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3110"], { env: { ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, NEXT_PUBLIC_SUPABASE_URL: cfg.API_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: cfg.PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY, AUTH_RATE_LIMIT_SECRET: secret }, windowsHide: true, stdio: "ignore" });
    await eventually(async () => { try { return (await fetch(origin)).status === 200; } catch { return false; } }, "Realtime test server did not start");
    staffCookie = (await req("/api/auth/staff/login", { body: { staffCode: code, pin } })).cookie;
    managerCookie = (await req("/api/auth/manager/login", { body: { email, password } })).cookie;
    await t.test("stream admission enforces role, token, current assignment, tenant, selector and Origin", async () => {
      for (const path of [`/api/staff/events?serviceId=${f.sa}`, `/api/manager/events?locationId=${f.a}`]) assert.equal((await req(path)).status, 401);
      assert.equal((await req(`/api/staff/events?serviceId=${f.sb}`, { cookie: staffCookie })).status, 403);
      assert.equal((await req(`/api/staff/events?serviceId=${f.sa}`, { cookie: managerCookie })).status, 403);
      assert.equal((await req(`/api/manager/events?locationId=${f.foreignLoc}`, { cookie: managerCookie })).status, 404);
      assert.equal((await req("/api/manager/events", { cookie: managerCookie })).status, 400);
      assert.equal((await req(`/api/public/tickets/${randomUUID()}/events`)).status, 404);
      assert.equal((await req(`/api/staff/events?serviceId=${f.sa}`, { cookie: staffCookie, headers: { origin: "https://foreign.invalid" } })).status, 403);
      assert.equal((await req(`/api/staff/events?serviceId=${f.sa}&locationId=${f.a}`, { cookie: staffCookie })).status, 400);
    });
    await t.test("customer join sends staff and Location A manager an event; Location B receives none", async () => {
      staffEvents = await events(`/api/staff/events?serviceId=${f.sa}`, staffCookie);
      aEvents = await events(`/api/manager/events?locationId=${f.a}`, managerCookie);
      bEvents = await events(`/api/manager/events?locationId=${f.b}`, managerCookie);
      const otherBefore = count(bEvents), managerBefore = count(aEvents);
      const result = await changed(staffEvents, () => join("First private customer")); assert.equal(result.status, 201); first = result.data;
      await eventually(() => count(aEvents) > managerBefore, "Selected-location counts did not receive invalidation");
      assert.equal((await counts(f.a)).data.waitingNow, 1); assert.equal((await counts(f.b)).data.waitingNow, 0);
      assert.equal((await req(`/api/staff/queue?serviceId=${f.sa}`, { cookie: staffCookie })).data.waiting[0].customerName, "First private customer");
      await delay(600); assert.equal(count(bEvents), otherBefore);
    });
    await t.test("CALL NEXT changes the private ticket and the next customer's position through realtime", async () => {
      const joined = await join("Second private customer"); assert.equal(joined.status, 201); second = joined.data;
      keys.add(`realtime:ticket:${first.token}`); keys.add(`realtime:ticket:${second.token}`);
      first.events = await events(`/api/public/tickets/${first.token}/events`);
      second.events = await events(`/api/public/tickets/${second.token}/events`);
      assert.equal((await ticket(second.token)).data.ticket.peopleAhead, 1);
      assert.equal((await ticket(second.token)).data.ticket.estimatedWaitMinutes, 5);
      const before = count(second.events);
      const called = await changed(first.events, () => action("call-next", { serviceId: f.sa })); assert.equal(called.status, 200); first.id = called.data.ticket.id;
      await eventually(() => count(second.events) > before, "Waiting customer's queue position did not receive an update");
      assert.equal((await ticket(first.token)).data.ticket.status, "SERVING"); assert.equal((await ticket(second.token)).data.ticket.peopleAhead, 0);
      assert.equal((await ticket(second.token)).data.ticket.estimatedWaitMinutes, 0);
      assert.equal((await ticket(first.token)).data.ticket.estimatedWaitMinutes, null);
      assert.deepEqual((await counts(f.a)).data, { waitingNow: 1, currentlyServing: 1, servedToday: 0 });
    });
    await t.test("COMPLETE and SKIP send updates; authorized polling remains the source of truth", async () => {
      assert.equal((await changed(first.events, () => action("complete", { ticketId: first.id }))).status, 200);
      assert.equal((await ticket(first.token)).data.ticket.status, "COMPLETED"); first.events.close();
      const called = await action("call-next", { serviceId: f.sa }); assert.equal(called.status, 200);
      await delay(500);
      assert.equal((await changed(second.events, () => action("skip", { ticketId: called.data.ticket.id }))).status, 200);
      assert.equal((await ticket(second.token)).data.ticket.status, "SKIPPED"); second.events.close();
      assert.deepEqual((await counts(f.a)).data, { waitingNow: 0, currentlyServing: 0, servedToday: 1 });
    });
    await t.test("switching location closes the old stream and the new stream receives only its location", async () => {
      aEvents.close(); await aEvents.done; const before = count(aEvents);
      const result = await changed(bEvents, () => join("Location B customer", f.b, f.sb)); assert.equal(result.status, 201);
      assert.equal(count(aEvents), before); assert.equal((await counts(f.b)).data.waitingNow, 1); assert.equal((await counts(f.a)).data.waitingNow, 0);
    });
    await t.test("assignment removal stops an already subscribed staff connection before forwarding further queue events", async () => {
      await delay(500); const before = count(staffEvents);
      sql(`delete from public.staff_assignments where staff_id='${f.staff}';`);
      assert.equal((await join("After revocation")).status, 201);
      await eventually(() => staffEvents.closed, "Revoked staff stream must close");
      assert.ok(staffEvents.events.includes("access-changed")); assert.equal(count(staffEvents), before);
      assert.equal((await req(`/api/staff/queue?serviceId=${f.sa}`, { cookie: staffCookie })).status, 403);
      assert.equal((await req(`/api/staff/events?serviceId=${f.sa}`, { cookie: staffCookie })).status, 403);
    });
    await t.test("logout terminates the manager stream; payloads contain no ticket records or credentials", async () => {
      assert.equal((await req("/api/auth/logout?role=manager", { cookie: managerCookie, body: {} })).status, 200);
      await eventually(() => bEvents.closed, "Logged-out manager stream must close");
      for (const stream of streams) {
        for (const frame of stream.text.split("\n\n").filter((x) => x.startsWith("event:"))) assert.match(frame, /^event: (ready|queue-changed|access-changed|keepalive)\ndata: \{\}$/);
        for (const value of [cfg.SERVICE_ROLE_KEY, hash, first.token, second.token, "First private customer", f.foreignLoc]) assert.ok(!stream.text.includes(value));
      }
    });
    await t.test("anonymous and Supabase authenticated browser clients cannot subscribe to or forge private queue signals", async () => {
      const anon = createClient(cfg.API_URL, cfg.PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const logged = createClient(cfg.API_URL, cfg.PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      try {
        assert.equal((await logged.auth.signInWithPassword({ email, password })).error, null);
        for (const client of [anon, logged]) {
          const status = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve("TIMEOUT"), 7000);
            client.channel(`queue:service:${f.sa}`, { config: { private: true } }).on("broadcast", { event: "queue_changed" }, () => assert.fail("Unauthorized event")).subscribe((value) => { if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT"].includes(value)) { clearTimeout(timer); resolve(value); } });
          });
          assert.equal(status, "CHANNEL_ERROR", "RLS must deny browser access, not silently rely on an unavailable server");
        }
        for (const role of ["anon", "authenticated"]) {
          assert.equal(sql(`select has_function_privilege('${role}','private.broadcast_queue_change()','EXECUTE');`), "f");
          assert.throws(() => sql(`begin; set local role ${role}; insert into realtime.messages(topic,extension,private,payload,event) values ('queue:service:${f.sa}','broadcast',true,'{}','queue_changed'); rollback;`));
        }
      } finally { await anon.removeAllChannels(); await logged.removeAllChannels(); await logged.auth.signOut(); }
    });
  } finally {
    streams.forEach((stream) => stream.close()); await Promise.all(streams.map((stream) => stream.done));
    if (server) { server.kill(); await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]); }
    const digests = [...keys].map((key) => createHmac("sha256", secret).update(key).digest("hex"));
    sql(`delete from private.auth_rate_limits where key_hash in (${digests.map(literal).join(",")});`);
    for (const table of ["queue_tickets", "service_daily_counters", "staff_assignments", "services", "staff", "locations", "managers"]) sql(`delete from public.${table} where organization_id in ('${f.org}','${f.foreignOrg}');`);
    sql(`delete from public.organizations where id in ('${f.org}','${f.foreignOrg}');`);
    if (user) await admin.auth.admin.deleteUser(user);
  }
});
