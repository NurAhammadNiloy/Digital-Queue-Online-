import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { hashPin } from "../lib/auth/pin.ts";
import { analyticsRange, duration } from "../lib/analytics/filters.ts";

const origin = "http://127.0.0.1:3107";
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
function sql(statement) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_digital-queue-management-system", "psql", "-X", "-qAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function localDate(instant, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function startDate(range, now, timezone) {
  const today = localDate(now, timezone);
  if (range === "all") return "0000-01-01";
  if (range === "month") return `${today.slice(0, 7)}-01`;
  if (range === "today") return today;
  return new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
}
const average = (rows, key) => rows.length ? rows.reduce((sum, row) => sum + row[key], 0) / rows.length : null;
function close(actual, expected) { if (expected === null) assert.equal(actual, null); else assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} ≈ ${expected}`); }

test("analytics filters reject overrides and duration display distinguishes zero from missing", () => {
  assert.equal(analyticsRange(new URLSearchParams()), "today");
  for (const range of ["today", "7days", "month", "all"]) assert.equal(analyticsRange(new URLSearchParams({ range })), range);
  for (const query of ["range=", "range=year", "range=all&range=today", "organizationId=x", "range=all&staffId=x"]) assert.equal(analyticsRange(new URLSearchParams(query)), null);
  assert.equal(duration(null), "—"); assert.equal(duration(0), "0 sec"); assert.equal(duration(59.6), "1 min"); assert.equal(duration(125), "2 min 5 sec");
});

test("manager analytics — real PostgreSQL, Auth, production HTTP and rendered pages", { timeout: 180000 }, async (t) => {
  const cfg = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "exec", "--yes", "--package=supabase@2.117.0", "--", "supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(new URL(cfg.API_URL).hostname, "127.0.0.1", "Local fixtures only");
  const admin = createClient(cfg.API_URL, cfg.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const f = Object.fromEntries(["org", "otherOrg", "loc", "westLoc", "otherLoc", "serviceA", "serviceB", "serviceC", "emptyService", "otherService", "staffA", "staffB", "emptyStaff", "otherStaff"].map((key) => [key, randomUUID()]));
  const tag = randomBytes(6).toString("hex"), secret = randomBytes(32).toString("hex"), password = randomBytes(32).toString("base64url"), pin = "493827", pinHash = await hashPin(pin);
  const emails = [`analytics-${tag}@example.invalid`, `analytics-other-${tag}@example.invalid`], code = `ANALYTICS_${tag.toUpperCase()}`;
  const users = [], cookies = [], rateKeys = ["ip:shared-origin", `staff:account:${code}`, ...emails.map((email) => `manager:account:${email}`)].map((key) => createHmac("sha256", secret).update(key).digest("hex"));
  let server, output = "", staffCookie, expected;
  async function req(path, { cookie = cookies[0], method = "GET", body } = {}) {
    const headers = {}; if (cookie) headers.cookie = cookie;
    if (method !== "GET") { headers.origin = origin; headers["content-type"] = "application/json"; }
    const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = null; }
    return { response, data, text, cookie: response.headers.getSetCookie()[0]?.split(";")[0] };
  }
  const report = (range = "today", cookie = cookies[0], locationId = cookie === cookies[1] ? f.otherLoc : f.loc) => req(`/api/manager/analytics?locationId=${locationId}&range=${range}`, { cookie });
  const hashCookie = (cookie) => digest(cookie.split("=")[1]);
  const start = (timezone, period = "day") => `(date_trunc('${period}',now() at time zone '${timezone}') at time zone '${timezone}')`;
  try {
    for (const email of emails) { const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true }); assert.equal(error, null); users.push(data.user.id); }
    sql(`insert into public.organizations(id,name) values ('${f.org}','Analytics tests'),('${f.otherOrg}','Foreign analytics');
      insert into public.managers(user_id,organization_id,name) values ('${users[0]}','${f.org}','Analytics manager'),('${users[1]}','${f.otherOrg}','Foreign analytics manager');`);
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3107"], {
      env: { ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, NEXT_PUBLIC_SUPABASE_URL: cfg.API_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: cfg.PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY, AUTH_RATE_LIMIT_SECRET: secret }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { output += chunk; }); server.stderr.on("data", (chunk) => { output += chunk; });
    let ready = false;
    for (let i = 0; i < 80; i++) { if (server.exitCode !== null) throw new Error("Analytics server failed; check port 3107."); try { if ((await fetch(origin)).status === 200) { ready = true; break; } } catch {} await delay(250); }
    assert.ok(ready);
    for (const email of emails) { const r = await req("/api/auth/manager/login", { cookie: null, method: "POST", body: { email, password } }); assert.equal(r.response.status, 200); cookies.push(r.cookie); }
    await t.test("unauthenticated and invalid-session requests cannot read analytics", async () => {
      for (const cookie of [null, "__Host-queue-manager-session=invalid"]) {
        assert.equal((await report("all", cookie)).response.status, 401);
        const page = await req("/manager/analytics", { cookie }); assert.equal(page.response.status, 307); assert.equal(new URL(page.response.headers.get("location"), origin).pathname, "/manager/login");
      }
    });
    await t.test("empty organization renders setup guidance and cannot aggregate without a location", async () => {
      assert.equal((await req("/api/manager/analytics")).response.status, 400);
      assert.equal((await report()).response.status, 404);
      const page = await req("/manager/analytics"); assert.equal(page.response.status, 200); assert.ok(page.text.includes("No locations configured"));
    });
    await t.test("calendar boundaries cover timezone offsets, inclusive seven days, month rollover, leap day and DST", () => {
      const cases = [
        ["today", "Pacific/Kiritimati", "2026-01-01T01:00:00Z", "2025-12-31T10:00:00Z"],
        ["today", "America/Los_Angeles", "2026-01-01T01:00:00Z", "2025-12-31T08:00:00Z"],
        ["7days", "UTC", "2026-01-03T12:00:00Z", "2025-12-28T00:00:00Z"],
        ["month", "America/Los_Angeles", "2026-03-01T01:00:00Z", "2026-02-01T08:00:00Z"],
        ["7days", "UTC", "2024-03-01T12:00:00Z", "2024-02-24T00:00:00Z"],
        ["today", "America/New_York", "2026-03-08T20:00:00Z", "2026-03-08T05:00:00Z"],
        ["today", "America/New_York", "2026-11-01T20:00:00Z", "2026-11-01T04:00:00Z"],
        ["7days", "America/New_York", "2026-03-10T12:00:00Z", "2026-03-04T05:00:00Z"],
      ];
      for (const [range, zone, now, boundary] of cases) assert.equal(sql(`select private.analytics_range_start('${range}','${zone}','${now}')='${boundary}'::timestamptz;`), "t");
      assert.equal(sql("select private.analytics_range_start('all','UTC',now())='-infinity'::timestamptz;"), "t");
    });
    sql(`insert into public.locations(id,organization_id,name,slug,timezone) values
      ('${f.loc}','${f.org}','East location','analytics-east-${tag}','Pacific/Kiritimati'),('${f.westLoc}','${f.org}','West location','analytics-west-${tag}','America/Los_Angeles'),('${f.otherLoc}','${f.otherOrg}','Foreign location','analytics-foreign-${tag}','UTC');
      insert into public.services(id,organization_id,location_id,name,queue_prefix,default_service_minutes,active) values
      ('${f.serviceA}','${f.org}','${f.loc}','Same name','A',5,true),('${f.serviceB}','${f.org}','${f.loc}','Inactive service','B',5,false),
      ('${f.serviceC}','${f.org}','${f.westLoc}','Same name','C',5,true),('${f.emptyService}','${f.org}','${f.westLoc}','Empty service','E',5,true),
      ('${f.otherService}','${f.otherOrg}','${f.otherLoc}','Foreign service','F',5,true);
      insert into public.staff(id,organization_id,name,staff_code,pin_hash,active) values
      ('${f.staffA}','${f.org}','Staff A','${code}',${literal(pinHash)},true),('${f.staffB}','${f.org}','Staff B','AN_B_${tag}',${literal(pinHash)},false),
      ('${f.emptyStaff}','${f.org}','Empty staff','AN_E_${tag}',${literal(pinHash)},true),('${f.otherStaff}','${f.otherOrg}','Foreign staff','AN_F_${tag}',${literal(pinHash)},true);`.replaceAll(`AN_B_${tag}`, `AN_B_${tag.toUpperCase()}`).replaceAll(`AN_E_${tag}`, `AN_E_${tag.toUpperCase()}`).replaceAll(`AN_F_${tag}`, `AN_F_${tag.toUpperCase()}`));
    const east = start("Pacific/Kiritimati"), west = start("America/Los_Angeles"), month = start("Pacific/Kiritimati", "month");
    const specs = [
      [f.serviceA, f.staffA, f.loc, east, 60, 120], [f.serviceA, f.staffA, f.loc, east, 180, 240],
      [f.serviceB, f.staffA, f.loc, east, 0, 0], [f.serviceB, f.staffB, f.loc, `${east}-interval '6 days'`, 300, 600],
      [f.serviceA, f.staffB, f.loc, `${east}-interval '6 days 1 second'`, 600, 1200],
      [f.serviceA, f.staffA, f.loc, month, 90, 30], [f.serviceA, f.staffA, f.loc, `${month}-interval '1 second'`, 30, 60],
      [f.serviceA, f.staffA, f.loc, `${east}-interval '100 days'`, 45, 75], [f.serviceC, f.staffA, f.westLoc, west, 240, 360],
      [f.serviceA, f.staffA, f.loc, "now()+interval '2 days'", 999, 999],
    ];
    const values = specs.map(([service, staff, loc, time, wait, duration], i) => `('${service}'::uuid,'${staff}'::uuid,'${loc}'::uuid,${i + 1},(${time}),${wait},${duration})`).join(",");
    const inserted = JSON.parse(sql(`with fixture(service_id,staff_id,location_id,n,finish,wait_seconds,service_seconds) as (values ${values}), inserted as (
      insert into public.queue_tickets(organization_id,location_id,service_id,queue_date,queue_sequence,queue_prefix,customer_name,status,joined_at,started_at,completed_at,served_by_staff_id)
      select '${f.org}',location_id,service_id,current_date-200,n,'T','Private analytics customer','COMPLETED',finish-make_interval(secs=>wait_seconds+service_seconds),finish-make_interval(secs=>service_seconds),finish,staff_id from fixture
      returning service_id,served_by_staff_id,location_id,queue_sequence,completed_at)
      select jsonb_agg(to_jsonb(inserted)) from inserted;`));
    expected = inserted.map((row) => ({ locationId: row.location_id, service: row.service_id, staff: row.served_by_staff_id, completedAt: row.completed_at, timezone: row.location_id === f.loc ? "Pacific/Kiritimati" : "America/Los_Angeles", wait: specs[row.queue_sequence - 1][4], duration: specs[row.queue_sequence - 1][5] }));
    sql(`insert into public.queue_tickets(organization_id,location_id,service_id,queue_date,queue_sequence,queue_prefix,customer_name,status,joined_at,started_at,skipped_at,served_by_staff_id) values
      ('${f.org}','${f.loc}','${f.serviceA}',current_date,90,'T','Private waiting','WAITING',now()-interval '30 days',null,null,null),
      ('${f.org}','${f.loc}','${f.serviceA}',current_date,91,'T','Private waiting','WAITING',now(),null,null,null),
      ('${f.org}','${f.loc}','${f.serviceA}',current_date,92,'T','Private serving','SERVING',now()-interval '1 day',now()-interval '12 hours',null,'${f.staffB}'),
      ('${f.org}','${f.loc}','${f.serviceA}',current_date,93,'T','Private skipped','SKIPPED',now()-interval '1 day',now()-interval '12 hours',now(),'${f.staffA}');
      insert into public.queue_tickets(organization_id,location_id,service_id,queue_date,queue_sequence,queue_prefix,customer_name,status,joined_at,started_at,completed_at,served_by_staff_id)
      values('${f.otherOrg}','${f.otherLoc}','${f.otherService}',current_date,1,'F','Foreign customer','COMPLETED',now()-interval '4 days',now()-interval '2 days',now(),'${f.otherStaff}');`);
    for (const locationId of [f.loc, f.westLoc]) for (const range of ["today", "7days", "month", "all"]) await t.test(`${locationId === f.loc ? "East" : "West"} ${range}: completion-date selection and ticket-weighted summary, service and staff averages`, async () => {
      const r = await report(range, cookies[0], locationId); assert.equal(r.response.status, 200, r.text); assert.equal(r.data.range, range);
      const rows = expected.filter((row) => row.locationId === locationId && new Date(row.completedAt) <= new Date(r.data.asOf) && localDate(row.completedAt, row.timezone) >= startDate(range, r.data.asOf, row.timezone));
      close(r.data.summary.averageWaitSeconds, average(rows, "wait")); close(r.data.summary.averageServiceSeconds, average(rows, "duration"));
      assert.equal(r.data.summary.waitingNow, locationId === f.loc ? 2 : 0, "Live waiting ignores history range and includes old waiting tickets");
      assert.equal(r.data.summary.servedToday, expected.filter((row) => row.locationId === locationId && new Date(row.completedAt) <= new Date(r.data.asOf) && localDate(row.completedAt, row.timezone) === localDate(r.data.asOf, row.timezone)).length);
      assert.equal(r.data.services.length, 2); assert.equal(r.data.summary.servedCount, rows.length);
      assert.deepEqual(new Set(r.data.staff.map((s) => s.id)), new Set(rows.map((row) => row.staff)));
      for (const service of r.data.services) { const selected = rows.filter((row) => row.service === service.id); assert.equal(service.servedCount, selected.length); close(service.averageWaitSeconds, average(selected, "wait")); close(service.averageServiceSeconds, average(selected, "duration")); }
      for (const staff of r.data.staff) { const selected = rows.filter((row) => row.staff === staff.id); assert.equal(staff.servedCount, selected.length); close(staff.averageServiceSeconds, average(selected, "duration")); }
      assert.equal(r.data.services.reduce((sum, row) => sum + row.servedCount, 0), rows.length);
      assert.equal(r.data.staff.reduce((sum, row) => sum + row.servedCount, 0), rows.length);
    });
    await t.test("zero-data entities, zero-duration tickets, inactive history and same-name services stay distinct", async () => {
      const r = (await report("all")).data;
      for (const row of [(await report("all", cookies[0], f.westLoc)).data.services.find((s) => s.id === f.emptyService)]) { assert.equal(row.servedCount, 0); assert.equal(row.averageServiceSeconds, null); }
      assert.equal(r.services.filter((s) => s.name === "Same name").length, 1); assert.ok(!r.staff.some((s) => s.id === f.emptyStaff));
      assert.equal(r.services.find((s) => s.id === f.serviceB).active, false); assert.equal(r.services.find((s) => s.id === f.serviceB).servedCount, 2);
      assert.equal(r.staff.find((s) => s.id === f.staffB).active, false); assert.equal(r.staff.find((s) => s.id === f.staffB).servedCount, 2);
      const today = (await report()).data.services.find((s) => s.id === f.serviceB); assert.equal(today.servedCount, 1); assert.equal(today.averageWaitSeconds, 0); assert.equal(today.averageServiceSeconds, 0);
    });
    await t.test("organization isolation and response allowlist exclude customer records and secrets", async () => {
      const own = await report("all"), foreign = await report("all", cookies[1]);
      assert.equal(foreign.data.services.length, 1); assert.equal(foreign.data.services[0].id, f.otherService); assert.equal(foreign.data.staff[0].id, f.otherStaff);
      assert.deepEqual(Object.keys(own.data).sort(), ["asOf", "range", "services", "staff", "summary"]);
      assert.deepEqual(Object.keys(own.data.services[0]).sort(), ["active", "averageServiceSeconds", "averageWaitSeconds", "id", "locationName", "name", "servedCount"]);
      assert.deepEqual(Object.keys(own.data.staff[0]).sort(), ["active", "averageServiceSeconds", "id", "name", "servedCount"]);
      for (const value of [f.otherOrg, f.otherStaff, f.otherService, "Foreign customer", "Private analytics customer", "ticket_token", "joined_at", "pin_hash", pinHash, cfg.SERVICE_ROLE_KEY]) assert.ok(!own.text.includes(value));
    });
    await t.test("filters are strict on both API and page and reject browser identity overrides", async () => {
      for (const query of ["range=year", "range=", "range=all&range=today", `organizationId=${f.otherOrg}`, "range=all&staffId=x", "range=all&asOf=2020-01-01"]) {
        assert.equal((await req(`/api/manager/analytics?${query}`)).response.status, 400);
        assert.equal((await req(`/manager/analytics?${query}`)).response.status, 404);
      }
      assert.equal((await req(`/api/manager/analytics?locationId=${f.loc}`)).data.range, "today");
      assert.equal((await report("all", cookies[0], f.otherLoc)).response.status, 404);
      assert.equal((await req(`/manager/analytics?locationId=${f.otherLoc}`)).response.status, 404);
    });
    await t.test("server-rendered cards, tables and all filters work without client raw history", async () => {
      for (const range of ["today", "7days", "month", "all"]) {
        const page = await req(`/manager/analytics?locationId=${f.loc}&range=${range}`); assert.equal(page.response.status, 200);
        for (const label of ["Served today", "Waiting now", "Average waiting time", "Average service duration", "By service", "Staff performance", "Today", "Last 7 days", "This month", "All time", "Same name", "Staff A"]) assert.ok(page.text.includes(label), label);
        assert.match(page.text, new RegExp(`<option[^>]*selected=""[^>]*value="${range}"|<option[^>]*value="${range}"[^>]*selected=""`));
        assert.match(page.response.headers.get("cache-control"), /no-store/); assert.ok(!page.text.includes("Private analytics customer")); assert.ok(!page.text.includes(pinHash));
      }
      assert.ok((await req("/manager")).text.includes('href="/manager/analytics"'));
    });
    await t.test("staff cannot read analytics; RPC independently rejects staff, invalid or expired sessions", async () => {
      const login = await req("/api/auth/staff/login", { cookie: null, method: "POST", body: { staffCode: code, pin } }); assert.equal(login.response.status, 200); staffCookie = login.cookie;
      assert.equal((await report("all", staffCookie)).response.status, 403); assert.equal((await req("/manager/analytics", { cookie: staffCookie })).response.status, 307);
      for (const hash of [hashCookie(staffCookie), "0".repeat(64)]) assert.equal((await admin.rpc("get_manager_analytics", { p_token_hash: hash, p_location_id: f.loc })).error.code, "42501");
      sql(`update private.app_sessions set expires_at=now()-interval '1 second' where token_hash='${hashCookie(cookies[1])}';`);
      assert.equal((await report("all", cookies[1])).response.status, 401);
      assert.equal((await admin.rpc("get_manager_analytics", { p_token_hash: hashCookie(cookies[1]), p_location_id: f.otherLoc })).error.code, "42501");
    });
    await t.test("browser roles cannot execute analytics functions; RPC validates range independently", async () => {
      for (const role of ["anon", "authenticated"]) assert.equal(sql(`select has_function_privilege('${role}','public.get_manager_analytics(text,uuid,text)','EXECUTE') or has_function_privilege('${role}','private.analytics_range_start(text,text,timestamptz)','EXECUTE');`), "f");
      const anon = createClient(cfg.API_URL, cfg.PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      assert.ok((await anon.rpc("get_manager_analytics", { p_token_hash: hashCookie(cookies[0]), p_location_id: f.loc })).error);
      for (const range of ["year", "", null]) assert.equal((await admin.rpc("get_manager_analytics", { p_token_hash: hashCookie(cookies[0]), p_location_id: f.loc, p_range: range })).error.code, "22023");
    });
    await t.test("analytics reads preserve queue history and logout revokes analytics access", async () => {
      assert.equal(sql(`select count(*) from public.queue_tickets where organization_id='${f.org}';`), "14");
      assert.equal((await req("/api/auth/logout", { method: "POST", body: {} })).response.status, 200);
      assert.equal((await report()).response.status, 401); assert.equal((await req("/manager/analytics")).response.status, 307);
      assert.equal((await admin.rpc("get_manager_analytics", { p_token_hash: hashCookie(cookies[0]), p_location_id: f.loc })).error.code, "42501");
    });
    assert.ok(!output.includes(password) && !output.includes(pinHash) && !output.includes(cfg.SERVICE_ROLE_KEY));
  } finally {
    if (server) { server.kill(); await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]); }
    sql(`delete from private.auth_rate_limits where key_hash in (${rateKeys.map(literal).join(",")});`);
    for (const table of ["queue_tickets", "service_daily_counters", "staff_assignments", "services", "staff", "locations", "managers"]) sql(`delete from public.${table} where organization_id in ('${f.org}','${f.otherOrg}');`);
    sql(`delete from public.organizations where id in ('${f.org}','${f.otherOrg}');`);
    for (const id of users) { const { error } = await admin.auth.admin.deleteUser(id); assert.equal(error, null); }
  }
});
