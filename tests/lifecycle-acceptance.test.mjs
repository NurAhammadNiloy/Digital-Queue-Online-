// HTTP/rendered-page fallback: real browser clicks, polling timers and viewport
// rendering are deliberately not claimed by this acceptance check.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { hashPin } from "../lib/auth/pin.ts";

const origin = "http://127.0.0.1:3105";
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
function sql(statement) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_digital-queue-management-system", "psql", "-X", "-qAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

test("exact customer/staff lifecycle acceptance — HTTP and rendered pages", { timeout: 120000 }, async (t) => {
  assert.ok(process.env.npm_execpath, "Run with npm run test:acceptance.");
  const cfg = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "exec", "--yes", "--package=supabase@2.117.0", "--", "supabase", "status", "-o", "json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(new URL(cfg.API_URL).hostname, "127.0.0.1", "Local fixtures only.");
  const f = { org: randomUUID(), loc: randomUUID(), service: randomUUID(), staff: randomUUID() };
  const tag = randomBytes(6).toString("hex"), slug = `acceptance-${tag}`, code = `ACCEPT_${tag.toUpperCase()}`;
  const pin = "493827", pinHash = await hashPin(pin), secret = randomBytes(32).toString("hex");
  const rateKeys = ["public:join:ip:shared-origin", "public:read:ip:shared-origin", "ip:shared-origin", `staff:account:${code}`]
    .map((key) => createHmac("sha256", secret).update(key).digest("hex"));
  let server, output = "", locationPage, serviceId, customerName, first, currentId, cookie;
  async function request(path, { method = "GET", body, staff = false, form = false, key } = {}) {
    const headers = {};
    // Distinct customer/staff contexts: public requests never receive the staff cookie.
    if (staff && cookie) headers.cookie = cookie;
    if (key) headers["idempotency-key"] = key;
    if (method === "POST") { headers.origin = origin; headers["content-type"] = form ? "application/x-www-form-urlencoded" : "application/json"; }
    const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : form ? new URLSearchParams(body) : JSON.stringify(body), redirect: "manual" });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    return { response, data, text, cookie: response.headers.getSetCookie()[0]?.split(";")[0] };
  }
  const queue = () => request(`/api/staff/queue?serviceId=${serviceId}`, { staff: true });
  const action = (name, body) => request(`/api/staff/queue/${name}`, { method: "POST", body, staff: true });
  const join = (name) => request(`/api/public/locations/${slug}/tickets`, { method: "POST", body: { name, serviceId }, key: randomUUID() });
  const status = (token) => request(`/api/public/tickets/${token}`);
  function privateHeaders(response, referrerPolicy = "no-referrer") {
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("referrer-policy"), referrerPolicy);
  }
  try {
    sql(`insert into public.organizations(id,name) values ('${f.org}','Lifecycle acceptance');
      insert into public.locations(id,organization_id,name,slug) values ('${f.loc}','${f.org}','Acceptance reception','${slug}');
      insert into public.services(id,organization_id,location_id,name,queue_prefix,default_service_minutes) values ('${f.service}','${f.org}','${f.loc}','Reception service','A',5);
      insert into public.staff(id,organization_id,name,staff_code,pin_hash) values ('${f.staff}','${f.org}','Acceptance staff','${code}',${literal(pinHash)});
      insert into public.staff_assignments(organization_id,staff_id,location_id,service_id) values ('${f.org}','${f.staff}','${f.loc}','${f.service}');`);
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3105"], {
      env: { ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, NEXT_PUBLIC_SUPABASE_URL: cfg.API_URL,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: cfg.PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY, AUTH_RATE_LIMIT_SECRET: secret },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { output += chunk; }); server.stderr.on("data", (chunk) => { output += chunk; });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (server.exitCode !== null) throw new Error("Acceptance server failed to start; check port 3105.");
      try { if ((await fetch(origin)).status === 200) { ready = true; break; } } catch {}
      await delay(250);
    }
    assert.ok(ready);
    await t.test("1. Customer opens an active location page", async () => {
      locationPage = await request(`/q/${slug}`);
      assert.equal(locationPage.response.status, 200); assert.ok(locationPage.text.includes("Acceptance reception"));
      assert.ok(locationPage.text.includes("Join queue")); privateHeaders(locationPage.response);
    });
    await t.test("2. Service selection is present and available through the public contract", async () => {
      const result = await request(`/api/public/locations/${slug}`); assert.equal(result.response.status, 200);
      assert.equal(result.data.location.services.length, 1); serviceId = result.data.location.services[0].id;
      assert.equal(serviceId, f.service); assert.ok(locationPage.text.includes(`value="${serviceId}"`));
      assert.equal(result.data.location.services[0].waitingCount, 0);
    });
    await t.test("3. Name input is rendered and customer supplies a name", () => {
      assert.match(locationPage.text, /<input\b[^>]*name="name"/);
      customerName = `Acceptance Customer ${tag}`;
    });
    await t.test("4. Customer joins through the public endpoint without authentication", async () => {
      const result = await join(customerName); assert.equal(result.response.status, 201, result.text);
      first = result.data; assert.equal(first.ticket.queueNumber, "A-001"); assert.equal(first.ticket.status, "WAITING");
      assert.equal(result.cookie, undefined); assert.equal(first.ticket.peopleAhead, 0);
    });
    await t.test("5. Customer receives and opens the private ticket page", async () => {
      assert.match(first.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(first.statusUrl, `/ticket/${first.token}`);
      const page = await request(first.statusUrl); assert.equal(page.response.status, 200);
      assert.ok(page.text.includes("A-001")); assert.ok(page.text.includes("Waiting")); privateHeaders(page.response);
      assert.match(page.response.headers.get("x-robots-tag"), /noindex/);
    });
    await t.test("6. Staff submits existing Staff ID/PIN login form", async () => {
      assert.equal((await request("/staff/login")).response.status, 200);
      const result = await request("/api/auth/staff/login", { method: "POST", form: true, body: { staffCode: code, pin } });
      assert.equal(result.response.status, 303); cookie = result.cookie;
      assert.equal(new URL(result.response.headers.get("location"), origin).pathname, "/staff/dashboard");
      for (const flag of ["HttpOnly", "Secure", "SameSite=lax"]) assert.ok(result.response.headers.getSetCookie()[0].includes(flag));
    });
    await t.test("7. Staff sees the customer first in the correct assigned queue", async () => {
      const result = await queue(); assert.equal(result.response.status, 200);
      assert.equal(result.data.staffName, "Acceptance staff"); assert.equal(result.data.selectedServiceId, serviceId);
      assert.equal(result.data.waitingTotal, 1); assert.equal(result.data.waiting[0].customerName, customerName);
      assert.equal(result.data.waiting[0].queueNumber, first.ticket.queueNumber); currentId = result.data.waiting[0].id;
      assert.notEqual(currentId, first.token); assert.equal(result.data.serving, null); assert.ok(!result.text.includes(first.token));
      const page = await request("/staff/dashboard", { staff: true }); assert.equal(page.response.status, 200);
      for (const value of [customerName, "A-001", "CALL NEXT", "Acceptance reception", "Reception service"]) assert.ok(page.text.includes(value));
      privateHeaders(page.response, "same-origin");
    });
    await t.test("8. Staff invokes CALL NEXT through the dashboard's existing action endpoint", async () => {
      const result = await action("call-next", { serviceId }); assert.equal(result.response.status, 200);
      assert.equal(result.data.ticket.id, currentId); assert.equal(result.data.ticket.status, "SERVING");
      const state = (await queue()).data; assert.equal(state.serving.id, currentId); assert.equal(state.waitingTotal, 0);
      const page = await request("/staff/dashboard", { staff: true });
      assert.ok(page.text.includes("COMPLETE")); assert.ok(page.text.includes("SKIP")); assert.ok(page.text.includes(customerName));
    });
    await t.test("9. Customer status endpoint and private page change to SERVING", async () => {
      const result = await status(first.token); assert.equal(result.response.status, 200);
      assert.equal(result.data.ticket.status, "SERVING"); assert.ok(result.data.ticket.calledAt); assert.equal(result.data.ticket.peopleAhead, null);
      const page = await request(first.statusUrl); assert.equal(page.response.status, 200); assert.ok(page.text.includes("Called — please go to the service"));
    });
    await t.test("10. Staff completes the serving ticket", async () => {
      const result = await action("complete", { ticketId: currentId }); assert.equal(result.response.status, 200);
      assert.equal(result.data.ticket.status, "COMPLETED"); assert.equal((await queue()).data.serving, null);
    });
    await t.test("11. Customer status endpoint and private page change to COMPLETED", async () => {
      const result = await status(first.token); assert.equal(result.data.ticket.status, "COMPLETED"); assert.ok(result.data.ticket.completedAt);
      const page = await request(first.statusUrl); assert.equal(page.response.status, 200); assert.ok(page.text.includes("Completed"));
    });
    await t.test("12. Another customer joins; staff calls and skips; customer sees SKIPPED", async () => {
      const result = await join(`Second Customer ${tag}`); assert.equal(result.response.status, 201);
      const second = result.data; assert.equal(second.ticket.queueNumber, "A-002"); assert.notEqual(second.token, first.token);
      assert.equal((await request(second.statusUrl)).response.status, 200);
      const state = (await queue()).data; assert.equal(state.waiting.length, 1); assert.equal(state.waiting[0].queueNumber, "A-002");
      const called = await action("call-next", { serviceId }); assert.equal(called.response.status, 200);
      assert.equal((await status(second.token)).data.ticket.status, "SERVING");
      assert.equal((await action("skip", { ticketId: called.data.ticket.id })).response.status, 200);
      const skipped = (await status(second.token)).data.ticket; assert.equal(skipped.status, "SKIPPED"); assert.ok(skipped.skippedAt);
      const page = await request(second.statusUrl); assert.equal(page.response.status, 200); assert.ok(page.text.includes("Skipped"));
      assert.ok(!page.text.includes(first.token)); assert.equal((await status(first.token)).data.ticket.status, "COMPLETED");
      assert.equal((await queue()).data.waitingTotal, 0); assert.equal((await queue()).data.serving, null);
    });
    await t.test("13. Logout invalidates staff dashboard and queue access, including cookie replay", async () => {
      assert.equal((await request("/api/auth/logout", { method: "POST", staff: true, body: {} })).response.status, 200);
      for (const staff of [true, false]) {
        const page = await request("/staff/dashboard", { staff }); assert.equal(page.response.status, 307);
        assert.equal(new URL(page.response.headers.get("location"), origin).pathname, "/staff/login");
        assert.equal((await request("/api/staff/queue", { staff })).response.status, 401);
      }
      assert.equal((await action("call-next", { serviceId })).response.status, 401);
      assert.equal((await status(first.token)).data.ticket.status, "COMPLETED");
    });
    assert.equal(sql(`select count(*) from public.queue_tickets where organization_id='${f.org}';`), "2");
    assert.ok(!output.includes(pinHash) && !output.includes(first.token) && !output.includes(customerName), "Sensitive fixture data is not logged.");
  } finally {
    if (server) { server.kill(); await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]); }
    sql(`delete from private.auth_rate_limits where key_hash in (${rateKeys.map(literal).join(",")});`);
    for (const table of ["queue_tickets", "service_daily_counters", "staff_assignments", "services", "staff", "locations"]) sql(`delete from public.${table} where organization_id='${f.org}';`);
    sql(`delete from public.organizations where id='${f.org}';`);
  }
});
