import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";

const origin = "http://127.0.0.1:3109";
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
function sql(statement) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_digital-queue-management-system", "psql", "-X", "-qAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

test("strict location isolation through manager, staff and customer contracts", { timeout: 180000 }, async (t) => {
  const cfg = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "exec", "--yes", "--package=supabase@2.117.0", "--", "supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(new URL(cfg.API_URL).hostname, "127.0.0.1", "Local fixtures only");
  const admin = createClient(cfg.API_URL, cfg.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const org = randomUUID(), foreignOrg = randomUUID(), foreignLoc = randomUUID(), tag = randomBytes(6).toString("hex");
  const email = `isolation-${tag}@example.invalid`, password = randomBytes(32).toString("base64url"), pin = "482937", secret = randomBytes(32).toString("hex");
  const codes = ["A", "B", "C"].map((letter) => `LOC_${letter}_${tag.toUpperCase()}`);
  const keys = ["ip:shared-origin", "public:join:ip:shared-origin", "public:read:ip:shared-origin", `manager:account:${email}`, ...codes.map((code) => `staff:account:${code}`)]
    .map((key) => createHmac("sha256", secret).update(key).digest("hex"));
  let server, userId, managerCookie, l1, l2, s1, s2, extra, a, c, ca, cb, cc, history, serverOutput = "";
  async function req(path, { cookie = managerCookie, method = "GET", body, key } = {}) {
    const headers = {}; if (cookie) headers.cookie = cookie;
    if (method !== "GET") { headers.origin = origin; headers["content-type"] = "application/json"; }
    if (key) headers["idempotency-key"] = key;
    const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = null; }
    return { status: response.status, text, data, cookie: response.headers.getSetCookie()[0]?.split(";")[0] };
  }
  const pair = (location, service) => ({ locationId: location.id, serviceId: service });
  const createLocation = async (name, timezone) => {
    const r = await req("/api/manager/locations", { method: "POST", body: { name, timezone, active: true } }); assert.equal(r.status, 201, r.text);
    return (await req(`/api/manager/locations/${r.data.id}`)).data.location;
  };
  const createService = async (location, name, prefix) => {
    const r = await req(`/api/manager/locations/${location.id}/services`, { method: "POST", body: { name, queuePrefix: prefix, defaultServiceMinutes: 5, active: true } }); assert.equal(r.status, 201); return r.data.id;
  };
  const createStaff = async (index, assignments) => {
    const r = await req("/api/manager/staff", { method: "POST", body: { name: `Staff ${["A", "B", "C"][index]}`, staffCode: codes[index], pin, assignments } }); assert.equal(r.status, 201, r.text); return r.data.id;
  };
  const login = async (index) => { const r = await req("/api/auth/staff/login", { method: "POST", cookie: null, body: { staffCode: codes[index], pin } }); assert.equal(r.status, 200); return r.cookie; };
  const queue = (cookie, service) => req(`/api/staff/queue${service ? `?serviceId=${service}` : ""}`, { cookie });
  const action = (cookie, verb, body) => req(`/api/staff/queue/${verb}`, { cookie, method: "POST", body });
  const customerJoin = async (location, service, name) => { const r = await req(`/api/public/locations/${location.slug}/tickets`, { cookie: null, method: "POST", key: randomUUID(), body: { name, serviceId: service } }); assert.equal(r.status, 201, r.text); return r.data; };
  const dashboard = (location) => req(`/api/manager/dashboard?locationId=${location.id}`);
  const analytics = (location, range = "all") => req(`/api/manager/analytics?locationId=${location.id}&range=${range}`);
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true }); assert.equal(created.error, null); userId = created.data.user.id;
    sql(`insert into public.organizations(id,name) values ('${org}','Isolation organization'),('${foreignOrg}','Foreign isolation');
      insert into public.managers(user_id,organization_id,name) values ('${userId}','${org}','Isolation manager');
      insert into public.locations(id,organization_id,name,slug) values ('${foreignLoc}','${foreignOrg}','Foreign location','foreign-${tag}');`);
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3109"], { env: {
      ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, NEXT_PUBLIC_SUPABASE_URL: cfg.API_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: cfg.PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY, AUTH_RATE_LIMIT_SECRET: secret,
    }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (chunk) => { serverOutput += chunk; }); server.stderr.on("data", (chunk) => { serverOutput += chunk; });
    let ready = false;
    for (let i = 0; i < 80; i++) { if (server.exitCode !== null) throw new Error("Isolation server failed; check port 3109."); try { if ((await fetch(origin)).status === 200) { ready = true; break; } } catch {} await delay(250); }
    assert.ok(ready);
    const loginResult = await req("/api/auth/manager/login", { method: "POST", body: { email, password } }); assert.equal(loginResult.status, 200); managerCookie = loginResult.cookie;
    await t.test("locations accept IANA timezones and reject invalid/offset values at API and database boundaries", async () => {
      l1 = await createLocation("Location One", "Europe/Helsinki"); s1 = await createService(l1, "One consultation", "A");
      a = await createStaff(0, [pair(l1, s1)]);
      l2 = await createLocation("Location Two", "America/Los_Angeles"); s2 = await createService(l2, "Two consultation", "B"); extra = await createService(l2, "Two restricted service", "X");
      for (const timezone of ["Invalid/Timezone", "UTC+3", "+03:00", "", null]) {
        assert.equal((await req(`/api/manager/locations/${l1.id}`, { method: "PUT", body: { name: l1.name, active: true, timezone } })).status, 400);
      }
      assert.throws(() => sql(`update public.locations set timezone='UTC+3' where id='${l1.id}';`));
      assert.equal((await req(`/api/manager/locations/${l1.id}`)).data.location.timezone, "Europe/Helsinki");
      assert.equal(l2.timezone, "America/Los_Angeles");
    });
    await t.test("existing staff editing discovers newly created locations and their services", async () => {
      const page = await req(`/manager/staff/${a}`); assert.equal(page.status, 200);
      for (const value of [l1.name, l2.name, "One consultation", "Two consultation", "Two restricted service", s1, s2, extra]) assert.ok(page.text.includes(value), value);
      assert.ok(!page.text.includes(foreignLoc));
      await createStaff(1, [pair(l2, s2)]); c = await createStaff(2, [pair(l1, s1), pair(l2, s2)]);
      ca = await login(0); cb = await login(1); cc = await login(2);
    });
    await t.test("A, B and C dashboards expose only their explicit location/service combinations", async () => {
      for (const [cookie, allowed] of [[ca, [pair(l1, s1)]], [cb, [pair(l2, s2)]], [cc, [pair(l1, s1), pair(l2, s2)]]]) {
        const r = await queue(cookie); assert.equal(r.status, 200);
        assert.deepEqual(new Set(r.data.assignments.map((x) => `${x.locationId}:${x.serviceId}`)), new Set(allowed.map((x) => `${x.locationId}:${x.serviceId}`)));
        const page = await req("/staff/dashboard", { cookie }); assert.equal(page.status, 200); assert.ok(!page.text.includes(extra));
      }
    });
    await t.test("customer pages and queues work independently; mismatched service/location is denied", async () => {
      for (const [location, service, other] of [[l1, s1, s2], [l2, s2, s1]]) {
        const page = await req(`/q/${location.slug}`, { cookie: null }); assert.equal(page.status, 200); assert.ok(page.text.includes(service)); assert.ok(!page.text.includes(other));
        assert.equal((await req(`/api/public/locations/${location.slug}/tickets`, { cookie: null, method: "POST", key: randomUUID(), body: { name: "Invalid assignment", serviceId: other } })).status, 400);
        const ticket = await customerJoin(location, service, `${location.name} historical customer`); assert.equal((await req(ticket.statusUrl, { cookie: null })).status, 200);
      }
    });
    await t.test("A and B cannot read/call the other location; C cannot use an unassigned service at an assigned location", async () => {
      for (const [cookie, service] of [[ca, s2], [cb, s1], [cc, extra]]) {
        assert.equal((await queue(cookie, service)).status, 403);
        assert.equal((await action(cookie, "call-next", { serviceId: service })).status, 403);
      }
    });
    await t.test("C serves both locations; A/B cannot complete or skip tickets at the other location", async () => {
      for (const [service, denied] of [[s1, cb], [s2, ca]]) {
        const called = await action(cc, "call-next", { serviceId: service }); assert.equal(called.status, 200); assert.ok(called.data.ticket);
        for (const verb of ["complete", "skip"]) assert.equal((await action(denied, verb, { ticketId: called.data.ticket.id })).status, 403);
        assert.equal((await action(cc, "complete", { ticketId: called.data.ticket.id })).status, 200);
      }
      history = sql(`select jsonb_agg(to_jsonb(t) order by id) from public.queue_tickets t where organization_id='${org}' and status='COMPLETED';`);
    });
    await t.test("removing C's permission immediately blocks reads/call/complete/skip without changing history", async () => {
      await customerJoin(l2, s2, "C pending reassignment");
      const called = await action(cc, "call-next", { serviceId: s2 }); assert.equal(called.status, 200);
      const changed = await req(`/api/manager/staff/${c}`, { method: "PUT", body: { name: "Staff C", staffCode: codes[2], assignments: [pair(l1, s1)] } }); assert.equal(changed.status, 200);
      const state = (await queue(cc)).data; assert.equal(state.assignments.length, 1); assert.equal(state.serving, null); assert.equal(state.servingAccessBlocked, true);
      assert.ok(!JSON.stringify(state).includes("C pending reassignment"));
      assert.equal((await queue(cc, s2)).status, 403); assert.equal((await action(cc, "call-next", { serviceId: s2 })).status, 403);
      for (const verb of ["complete", "skip"]) assert.equal((await action(cc, verb, { ticketId: called.data.ticket.id })).status, 403);
      assert.equal(sql(`select jsonb_agg(to_jsonb(t) order by id) from public.queue_tickets t where organization_id='${org}' and status='COMPLETED';`), history);
      // Restore via the manager transaction to finish the test's active ticket;
      // remove again afterward so reports must use past history, not assignments.
      assert.equal((await req(`/api/manager/staff/${c}`, { method: "PUT", body: { name: "Staff C", staffCode: codes[2], assignments: [pair(l1, s1), pair(l2, s2)] } })).status, 200);
      assert.equal((await action(cc, "skip", { ticketId: called.data.ticket.id })).status, 200);
      assert.equal((await req(`/api/manager/staff/${c}`, { method: "PUT", body: { name: "Staff C", staffCode: codes[2], assignments: [] } })).status, 200);
    });
    await t.test("each dashboard contains only selected-location operational counts", async () => {
      await customerJoin(l1, s1, "First waiting"); await customerJoin(l1, s1, "Second waiting"); await customerJoin(l2, s2, "Other location serving");
      assert.equal((await action(ca, "call-next", { serviceId: s1 })).status, 200); assert.equal((await action(cb, "call-next", { serviceId: s2 })).status, 200);
      assert.deepEqual((await dashboard(l1)).data, { waitingNow: 1, currentlyServing: 1, servedToday: 1 });
      assert.deepEqual((await dashboard(l2)).data, { waitingNow: 0, currentlyServing: 1, servedToday: 1 });
      const page = await req(`/manager?locationId=${l2.id}`); assert.equal(page.status, 200); assert.ok(page.text.includes('name="locationId"')); assert.ok(!page.text.includes("All locations"));
    });
    await t.test("all four analytics filters retain C's completed history only at the selected location", async () => {
      for (const location of [l1, l2]) for (const range of ["today", "7days", "month", "all"]) {
        const r = await analytics(location, range); assert.equal(r.status, 200, r.text);
        assert.equal(r.data.summary.servedCount, 1); assert.equal(r.data.summary.servedToday, 1); assert.equal(r.data.summary.waitingNow, location.id === l1.id ? 1 : 0);
        assert.equal(r.data.staff.length, 1); assert.equal(r.data.staff[0].id, c); assert.equal(r.data.staff[0].servedCount, 1);
        const otherService = location.id === l1.id ? s2 : s1; assert.ok(!r.text.includes(otherService));
        const expected = JSON.parse(sql(`select jsonb_build_object('wait',avg(extract(epoch from started_at-joined_at)),'duration',avg(extract(epoch from completed_at-started_at))) from public.queue_tickets where location_id='${location.id}' and status='COMPLETED';`));
        assert.equal(r.data.summary.averageWaitSeconds, expected.wait); assert.equal(r.data.summary.averageServiceSeconds, expected.duration);
      }
    });
    await t.test("missing, duplicate, malformed, unknown and cross-organization report locations are rejected", async () => {
      const hash = createHash("sha256").update(managerCookie.split("=")[1]).digest("hex");
      for (const endpoint of ["dashboard", "analytics"]) {
        for (const query of ["", "locationId=", "locationId=all", `locationId=${l1.id}&locationId=${l2.id}`, `locationId=${l1.id}&organizationId=${foreignOrg}`]) assert.equal((await req(`/api/manager/${endpoint}?${query}`)).status, 400);
        for (const id of [foreignLoc, randomUUID()]) {
          assert.equal((await req(`/api/manager/${endpoint}?locationId=${id}`)).status, 404);
          assert.equal((await admin.rpc(`get_manager_${endpoint}`, { p_token_hash: hash, p_location_id: id })).error.code, "P0002");
        }
        assert.equal((await admin.rpc(`get_manager_${endpoint}`, { p_token_hash: hash, p_location_id: null })).error.code, "22023");
        assert.ok((await admin.rpc(`get_manager_${endpoint}`, { p_token_hash: hash })).error, "Old unscoped RPC signature is unavailable");
      }
      for (const path of ["/manager", "/manager/analytics"]) { const page = await req(`${path}?locationId=${foreignLoc}`); assert.equal(page.status, 404); }
    });
    await t.test("an empty selected location has zero counts/null averages and no unrelated staff rows", async () => {
      const empty = await createLocation("Empty location", "Europe/Helsinki");
      assert.deepEqual((await dashboard(empty)).data, { waitingNow: 0, currentlyServing: 0, servedToday: 0 });
      const r = await analytics(empty); assert.equal(r.data.summary.servedCount, 0); assert.equal(r.data.summary.averageWaitSeconds, null); assert.equal(r.data.summary.averageServiceSeconds, null); assert.deepEqual(r.data.staff, []); assert.deepEqual(r.data.services, []);
      const page = await req(`/manager/analytics?locationId=${empty.id}`); assert.ok(page.text.includes("No completed tickets")); assert.ok(page.text.includes("No services yet"));
    });
    await t.test("assignment picker includes locations and services beyond the default database response cap", async () => {
      sql(`insert into public.locations(organization_id,name,slug) select '${org}','Catalog location '||n,'catalog-${tag}-'||n from generate_series(1,1001) n;
        insert into public.services(organization_id,location_id,name,queue_prefix,default_service_minutes)
        select '${org}','${l2.id}','Catalog service '||n,'Z'||chr(65+n/676)||chr(65+(n/26)%26)||chr(65+n%26),5 from generate_series(1,1001) n;`);
      // Bulk SQL blocks this test process longer than HTTP keep-alive. Let
      // undici consume pending socket-close events before reusing connections.
      await delay(100);
      const page = await req(`/manager/staff/${a}`).catch(() => { throw new Error(`Catalog rendering failed (exit ${server.exitCode}; heap exhaustion: ${/heap|out of memory/i.test(serverOutput)}; stack exhaustion: ${/stack|recursion/i.test(serverOutput)}).`); }); assert.equal(page.status, 200);
      assert.ok(page.text.includes(l2.name)); assert.ok(page.text.includes("Two restricted service")); assert.ok(page.text.includes("Catalog location 1001")); assert.ok(page.text.includes("Catalog service 1001"));
    });
  } finally {
    if (server) { server.kill(); await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]); }
    sql(`delete from private.auth_rate_limits where key_hash in (${keys.map(literal).join(",")});`);
    for (const table of ["queue_tickets", "service_daily_counters", "staff_assignments", "services", "staff", "locations", "managers"]) sql(`delete from public.${table} where organization_id in ('${org}','${foreignOrg}');`);
    sql(`delete from public.organizations where id in ('${org}','${foreignOrg}');`);
    if (userId) await admin.auth.admin.deleteUser(userId);
  }
});
