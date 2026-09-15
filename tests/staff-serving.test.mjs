import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { hashPin } from "../lib/auth/pin.ts";

const origin = "http://127.0.0.1:3104";
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
function sql(statement) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_digital-queue-management-system", "psql", "-X", "-qAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

test("staff serving dashboard and protected operations (real Supabase and production HTTP)", { timeout: 240000 }, async (t) => {
  assert.ok(process.env.npm_execpath, "Run with npm run test:serving.");
  const cfg = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "exec", "--yes", "--package=supabase@2.117.0", "--", "supabase", "status", "-o", "json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(new URL(cfg.API_URL).hostname, "127.0.0.1");
  const admin = createClient(cfg.API_URL, cfg.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const f = Object.fromEntries(["org", "foreignOrg", "loc", "secondLoc", "foreignLoc", "service", "secondService", "unassignedService", "foreignService", "staff", "coworker"].map((key) => [key, randomUUID()]));
  const tag = randomBytes(5).toString("hex"), code = `SERVE_${tag.toUpperCase()}`, coworkerCode = `PEER_${tag.toUpperCase()}`;
  const pin = "739126", pinHash = await hashPin(pin), secret = randomBytes(32).toString("hex");
  const email = `serve-manager-${tag}@example.invalid`, password = randomBytes(32).toString("base64url");
  const rateKeys = ["ip:shared-origin", `staff:account:${code}`, `staff:account:${coworkerCode}`, `manager:account:${email}`]
    .map((key) => createHmac("sha256", secret).update(key).digest("hex"));
  const clearRates = () => sql(`delete from private.auth_rate_limits where key_hash in (${rateKeys.map(literal).join(",")});`);
  const check = async (name, fn) => { clearRates(); await t.test(name, fn); };
  let server, managerId, cookie, peerCookie, managerCookie, output = "";
  async function request(path, { method = "GET", body, auth, form = false } = {}) {
    const headers = {};
    if (auth) headers.cookie = auth;
    if (method === "POST") { headers.origin = origin; headers["content-type"] = form ? "application/x-www-form-urlencoded" : "application/json"; }
    const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : form ? new URLSearchParams(body) : JSON.stringify(body), redirect: "manual" });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    return { response, text, data, cookie: response.headers.getSetCookie()[0]?.split(";")[0] };
  }
  const login = (staffCode = code, form = false) => request("/api/auth/staff/login", { method: "POST", body: { staffCode, pin }, form });
  const queue = (query = "", auth = cookie) => request(`/api/staff/queue${query}`, { auth });
  const action = (name, body, auth = cookie) => request(`/api/staff/queue/${name}`, { method: "POST", body, auth });
  const makeTicket = async (name = "Waiting customer", service = f.service, location = f.loc) => {
    const { data, error } = await admin.rpc("create_queue_ticket", { p_location_id: location, p_service_id: service, p_customer_name: name });
    assert.equal(error, null); return data;
  };
  const clearTickets = () => sql(`delete from public.queue_tickets where organization_id in ('${f.org}','${f.foreignOrg}');`);
  try {
    const account = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    assert.equal(account.error, null); managerId = account.data.user.id;
    sql(`insert into public.organizations(id,name) values ('${f.org}','Serving test'),('${f.foreignOrg}','Other organization');
      insert into public.managers(user_id,organization_id,name) values ('${managerId}','${f.org}','Test manager');
      insert into public.locations(id,organization_id,name,slug) values
        ('${f.loc}','${f.org}','Main location','serving-${tag}'),('${f.secondLoc}','${f.org}','Second location','serving-second-${tag}'),
        ('${f.foreignLoc}','${f.foreignOrg}','Foreign location','serving-foreign-${tag}');
      insert into public.services(id,organization_id,location_id,name,queue_prefix,default_service_minutes) values
        ('${f.service}','${f.org}','${f.loc}','A reception','A',5),('${f.secondService}','${f.org}','${f.secondLoc}','B reception','B',5),
        ('${f.unassignedService}','${f.org}','${f.loc}','Unassigned service','U',5),('${f.foreignService}','${f.foreignOrg}','${f.foreignLoc}','Foreign service','F',5);
      insert into public.staff(id,organization_id,name,staff_code,pin_hash) values
        ('${f.staff}','${f.org}','Serving staff','${code}',${literal(pinHash)}),('${f.coworker}','${f.org}','Other staff','${coworkerCode}',${literal(pinHash)});
      insert into public.staff_assignments(organization_id,staff_id,location_id,service_id) values
        ('${f.org}','${f.staff}','${f.loc}','${f.service}'),('${f.org}','${f.staff}','${f.secondLoc}','${f.secondService}'),
        ('${f.org}','${f.coworker}','${f.loc}','${f.service}');`);
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3104"], {
      env: { ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, NEXT_PUBLIC_SUPABASE_URL: cfg.API_URL,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: cfg.PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY, AUTH_RATE_LIMIT_SECRET: secret },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { output += chunk; }); server.stderr.on("data", (chunk) => { output += chunk; });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (server.exitCode !== null) throw new Error("Test server failed; check port 3104.");
      try { if ((await fetch(origin)).status === 200) { ready = true; break; } } catch {}
      await delay(250);
    }
    assert.ok(ready);
    await check("unauthenticated dashboard redirects and queue API rejects", async () => {
      const page = await request("/staff/dashboard"); assert.equal(page.response.status, 307);
      assert.equal(new URL(page.response.headers.get("location"), origin).pathname, "/staff/login");
      assert.equal((await queue("", null)).response.status, 401);
      assert.equal((await request("/staff/login")).response.status, 200);
    });
    await check("existing Staff ID/PIN form logs into dashboard with secure session", async () => {
      const result = await login(code, true); assert.equal(result.response.status, 303); cookie = result.cookie;
      assert.equal(new URL(result.response.headers.get("location"), origin).pathname, "/staff/dashboard");
      assert.ok(result.response.headers.getSetCookie()[0].includes("HttpOnly"));
      assert.ok(result.response.headers.getSetCookie()[0].includes("Secure"));
      peerCookie = (await login(coworkerCode)).cookie;
      const state = await queue(); assert.equal(state.response.status, 200, state.text);
      assert.equal(state.data.staffName, "Serving staff"); assert.equal(state.data.assignments.length, 2);
      assert.equal(state.data.selectedServiceId, f.service); assert.deepEqual(state.data.waiting, []); assert.equal(state.data.serving, null);
      const page = await request("/staff/dashboard", { auth: cookie }); assert.equal(page.response.status, 200);
      for (const text of ["Serving staff", "Main location", "Second location", "CALL NEXT", "Log out", "No waiting customers"]) assert.ok(page.text.includes(text));
      assert.equal((await request("/staff", { auth: cookie })).response.status, 200);
    });
    await check("manager role cannot read or render staff dashboard", async () => {
      const result = await request("/api/auth/manager/login", { method: "POST", body: { email, password } });
      assert.equal(result.response.status, 200); managerCookie = result.cookie;
      assert.equal((await queue("", managerCookie)).response.status, 403);
      assert.equal((await request("/staff/dashboard", { auth: managerCookie })).response.status, 307);
    });
    await check("reads reject impersonation, foreign/unassigned services and malformed query input", async () => {
      for (const id of [f.foreignService, f.unassignedService, randomUUID()]) assert.equal((await queue(`?serviceId=${id}`)).response.status, 403);
      for (const query of [`?staffId=${f.coworker}`, `?organizationId=${f.foreignOrg}`, `?locationId=${f.foreignLoc}`, "?serviceId=invalid", "?page=0", "?page=-1", "?page=1.5", "?page=100000", "?page=1&page=2", `?serviceId=${f.service}&serviceId=${f.secondService}`]) assert.equal((await queue(query)).response.status, 400);
    });
    await check("WAITING order matches joined_at then UUID, including previous days and only selected service", async () => {
      clearTickets();
      const tickets = [await makeTicket("First"), await makeTicket("Second"), await makeTicket("Third")];
      await makeTicket("Other location private name", f.secondService, f.secondLoc);
      await makeTicket("Foreign private name", f.foreignService, f.foreignLoc);
      sql(`update public.queue_tickets set joined_at=now()-interval '1 day' where service_id='${f.service}';`);
      const expected = JSON.parse(sql(`select json_agg(id order by joined_at,id) from public.queue_tickets where service_id='${f.service}';`));
      const result = await queue(); assert.deepEqual(result.data.waiting.map((t) => t.id), expected); assert.equal(result.data.waitingTotal, 3);
      for (const ticket of tickets) assert.ok(!result.text.includes(ticket.ticket_token));
      for (const secretValue of ["Other location private name", "Foreign private name", pinHash, cfg.SERVICE_ROLE_KEY, "served_by_staff_id"]) assert.ok(!result.text.includes(secretValue));
      const second = await queue(`?serviceId=${f.secondService}`); assert.equal(second.data.waiting.length, 1);
      assert.equal(second.data.waiting[0].customerName, "Other location private name");
    });
    await check("CALL NEXT selects the first ordered ticket and dashboard shows own current SERVING ticket", async () => {
      const before = (await queue()).data;
      const result = await action("call-next", { serviceId: f.service }); assert.equal(result.response.status, 200);
      assert.equal(result.data.ticket.id, before.waiting[0].id);
      const after = (await queue()).data; assert.equal(after.serving.id, before.waiting[0].id); assert.equal(after.waiting.length, 2);
      const otherSelection = (await queue(`?serviceId=${f.secondService}`)).data;
      assert.equal(otherSelection.serving.id, after.serving.id); assert.equal(otherSelection.selectedServiceId, f.secondService);
      const peer = (await queue("", peerCookie)).data; assert.equal(peer.serving, null);
      const page = await request("/staff/dashboard", { auth: cookie }); assert.ok(page.text.includes("COMPLETE")); assert.ok(page.text.includes("SKIP"));
      assert.equal((await action("call-next", { serviceId: f.secondService })).response.status, 409);
      assert.equal((await action("complete", { ticketId: after.serving.id }, peerCookie)).response.status, 403);
    });
    await check("COMPLETE and SKIP use existing protected actions and refreshed state", async () => {
      const current = (await queue()).data.serving;
      assert.equal((await action("complete", { ticketId: current.id })).response.status, 200);
      assert.equal((await queue()).data.serving, null);
      assert.equal(sql(`select status from public.queue_tickets where id='${current.id}';`), "COMPLETED");
      const called = await action("call-next", { serviceId: f.service }); assert.equal(called.response.status, 200);
      assert.equal((await action("skip", { ticketId: called.data.ticket.id })).response.status, 200);
      assert.equal(sql(`select status from public.queue_tickets where id='${called.data.ticket.id}';`), "SKIPPED");
      assert.equal((await queue()).data.serving, null);
    });
    await check("same-staff concurrent call-next creates only one serving ticket", async () => {
      clearTickets(); await makeTicket(); await makeTicket();
      const results = await Promise.all([action("call-next", { serviceId: f.service }), action("call-next", { serviceId: f.service })]);
      assert.deepEqual(results.map((r) => r.response.status).sort(), [200, 409]);
      assert.equal(sql(`select count(*) from public.queue_tickets where served_by_staff_id='${f.staff}' and status='SERVING';`), "1");
    });
    await check("different staff concurrently claim distinct tickets; one remaining ticket has one winner", async () => {
      clearTickets(); await makeTicket(); await makeTicket();
      const results = await Promise.all([action("call-next", { serviceId: f.service }), action("call-next", { serviceId: f.service }, peerCookie)]);
      assert.ok(results.every((r) => r.response.status === 200));
      assert.notEqual(results[0].data.ticket.id, results[1].data.ticket.id);
      assert.equal((await queue()).data.serving.id, results[0].data.ticket.id);
      assert.equal((await queue("", peerCookie)).data.serving.id, results[1].data.ticket.id);
      clearTickets(); await makeTicket();
      const last = await Promise.all([action("call-next", { serviceId: f.service }), action("call-next", { serviceId: f.service }, peerCookie)]);
      assert.ok(last.every((r) => r.response.status === 200)); assert.equal(last.filter((r) => r.data.ticket).length, 1);
    });
    await check("permission removal hides revoked data and blocks actions on the existing session", async () => {
      clearTickets(); await makeTicket("Revoked private customer");
      assert.equal((await action("call-next", { serviceId: f.service })).response.status, 200);
      sql(`delete from public.staff_assignments where staff_id='${f.staff}' and service_id='${f.service}';`);
      try {
        const result = await queue(); assert.equal(result.response.status, 200);
        assert.equal(result.data.serving, null); assert.equal(result.data.servingAccessBlocked, true);
        assert.ok(!result.text.includes("Revoked private customer")); assert.equal(result.data.assignments.length, 1);
        assert.equal((await queue(`?serviceId=${f.service}`)).response.status, 403);
        assert.equal((await action("call-next", { serviceId: f.service })).response.status, 403);
      } finally { sql(`insert into public.staff_assignments(organization_id,staff_id,location_id,service_id) values ('${f.org}','${f.staff}','${f.loc}','${f.service}');`); }
      assert.equal((await queue()).data.servingAccessBlocked, false);
    });
    await check("inactive assignments and no-assignment staff expose no waiting customer data", async () => {
      clearTickets(); await makeTicket("Hidden during closure");
      sql(`update public.locations set active=false where id='${f.loc}'; update public.services set active=false where id='${f.secondService}';`);
      try {
        const result = await queue(); assert.deepEqual(result.data.assignments, []); assert.deepEqual(result.data.waiting, []); assert.equal(result.data.selectedServiceId, null);
        assert.ok(!result.text.includes("Hidden during closure"));
      } finally { sql(`update public.locations set active=true where id='${f.loc}'; update public.services set active=true where id='${f.secondService}';`); }
    });
    await check("waiting pagination retains backend order without the default row-limit truncation", async () => {
      clearTickets();
      sql(`select public.create_queue_ticket('${f.loc}','${f.service}','Pagination customer') from generate_series(1,52);`);
      const first = (await queue()).data, second = (await queue("?page=2")).data;
      assert.equal(first.waiting.length, 50); assert.equal(second.waiting.length, 2); assert.equal(first.waitingTotal, 52);
      const expected = JSON.parse(sql(`select json_agg(id order by joined_at,id) from public.queue_tickets where service_id='${f.service}';`));
      assert.deepEqual([...first.waiting, ...second.waiting].map((t) => t.id), expected);
    });
    await check("queue reads/polling are read-only and responses are private", async () => {
      const before = sql(`select count(*) from public.queue_tickets where organization_id='${f.org}';`);
      for (let i = 0; i < 3; i++) assert.equal((await queue()).response.status, 200);
      assert.equal(sql(`select count(*) from public.queue_tickets where organization_id='${f.org}';`), before);
      for (const path of ["/api/staff/queue", "/staff/dashboard"]) {
        const result = await request(path, { auth: cookie }); assert.match(result.response.headers.get("cache-control"), /no-store/);
        assert.equal(result.response.headers.get("referrer-policy"), path.startsWith("/api/") ? "no-referrer" : "same-origin");
      }
      assert.equal((await request("/api/staff/queue", { method: "POST", body: {}, auth: cookie })).response.status, 405);
    });
    await check("expired/disabled sessions immediately lose dashboard and queue access", async () => {
      const expiring = (await login()).cookie;
      sql(`update private.app_sessions set expires_at=now()-interval '1 second',created_at=now()-interval '2 hours' where token_hash='${digest(expiring.split("=")[1])}';`);
      assert.equal((await queue("", expiring)).response.status, 401);
      assert.equal((await request("/staff/dashboard", { auth: expiring })).response.status, 307);
      sql(`update public.staff set active=false where id='${f.staff}';`);
      assert.equal((await queue()).response.status, 401);
      sql(`update public.staff set active=true where id='${f.staff}';`);
      assert.equal((await queue()).response.status, 401); cookie = (await login()).cookie;
    });
    await check("logout revokes session and blocks dashboard, reads and mutations", async () => {
      const result = await request("/api/auth/logout", { method: "POST", auth: cookie, body: {} }); assert.equal(result.response.status, 200);
      assert.equal((await queue()).response.status, 401);
      assert.equal((await request("/staff/dashboard", { auth: cookie })).response.status, 307);
      assert.equal((await action("call-next", { serviceId: f.service })).response.status, 401);
    });
    assert.ok(!output.includes(pinHash) && !output.includes(password));
  } finally {
    if (server) { server.kill(); await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]); }
    clearRates();
    for (const table of ["queue_tickets", "service_daily_counters", "staff_assignments", "services", "staff", "locations", "managers"]) sql(`delete from public.${table} where organization_id in ('${f.org}','${f.foreignOrg}');`);
    sql(`delete from public.organizations where id in ('${f.org}','${f.foreignOrg}');`);
    if (managerId) await admin.auth.admin.deleteUser(managerId);
  }
});
