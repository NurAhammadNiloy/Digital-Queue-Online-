// libcurl's cookie engine enforces host, Path, Secure, expiry and __Host- rules.
// No Cookie header is fabricated. SameSite=Lax is asserted; all accepted requests
// are same-origin. Chrome verification separately covers UI clicks and polling.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { hashPin } from "../lib/auth/pin.ts";
import { staffResponseError } from "../lib/staff/action-error.ts";

const origin = "http://localhost:3108";
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
function sql(statement) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_digital-queue-management-system", "psql", "-X", "-qAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

class CookieClient {
  directory = mkdtempSync(join(tmpdir(), "queue-cookie-test-"));
  request(path, { body, form = false, csrf = origin, headers = {} } = {}) {
    const jar = join(this.directory, "cookies.txt"), responseHeaders = join(this.directory, "headers.txt"), responseBody = join(this.directory, "body.txt");
    const args = ["--silent", "--show-error", "--max-time", "20", "--noproxy", "localhost", "--resolve", "localhost:3108:127.0.0.1",
      "--cookie", jar, "--cookie-jar", jar, "--dump-header", responseHeaders, "--output", responseBody, "--write-out", "%{http_code}"];
    if (body !== undefined) {
      args.push("--header", `Content-Type: ${form ? "application/x-www-form-urlencoded" : "application/json"}`, "--data-binary", "@-");
      if (csrf !== null) args.push("--header", `Origin: ${csrf}`);
    }
    for (const [name, value] of Object.entries(headers)) {
      assert.notEqual(name.toLowerCase(), "cookie", "Cookies must come from the cookie engine.");
      args.push("--header", `${name}: ${value}`);
    }
    args.push(`${origin}${path}`);
    const status = Number(execFileSync(process.platform === "win32" ? "curl.exe" : "curl", args, {
      input: body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }));
    const text = readFileSync(responseBody, "utf8"), rawHeaders = readFileSync(responseHeaders, "utf8");
    let data; try { data = JSON.parse(text); } catch { data = null; }
    return { status, text, data, headers: rawHeaders };
  }
  names() {
    return readFileSync(join(this.directory, "cookies.txt"), "utf8").split(/\r?\n/)
      .filter((line) => line && (!line.startsWith("#") || line.startsWith("#HttpOnly_"))).map((line) => line.split("\t")[5]).sort();
  }
  close() { for (const file of readdirSync(this.directory)) unlinkSync(join(this.directory, file)); rmdirSync(this.directory); }
}

test("cookie-aware staff actions alongside manager login", { timeout: 180000 }, async (t) => {
  const cfg = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "exec", "--yes", "--package=supabase@2.117.0", "--", "supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(new URL(cfg.API_URL).hostname, "127.0.0.1", "Local fixtures only");
  const admin = createClient(cfg.API_URL, cfg.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const f = { org: randomUUID(), loc: randomUUID(), service: randomUUID(), staff: randomUUID() };
  const tag = randomBytes(6).toString("hex"), code = `COOKIE_${tag.toUpperCase()}`, slug = `cookie-${tag}`;
  const email = `cookie-${tag}@example.invalid`, password = randomBytes(32).toString("base64url"), pin = "493827";
  const secret = randomBytes(32).toString("hex"), pinHash = await hashPin(pin);
  const keys = ["ip:shared-origin", "public:join:ip:shared-origin", "public:read:ip:shared-origin", `staff:account:${code}`, `manager:account:${email}`]
    .map((key) => createHmac("sha256", secret).update(key).digest("hex"));
  const browser = new CookieClient(), customer = new CookieClient();
  const staffLogin = () => browser.request("/api/auth/staff/login", { form: true, body: { staffCode: code, pin } });
  const managerLogin = () => browser.request("/api/auth/manager/login", { form: true, body: { email, password } });
  const queue = () => browser.request(`/api/staff/queue?serviceId=${f.service}`);
  const action = (name, body, extra = {}) => browser.request(`/api/staff/queue/${name}`, { body, ...extra });
  const status = (token) => customer.request(`/api/public/tickets/${token}`).data.ticket.status;
  const counts = () => browser.request(`/api/manager/dashboard?locationId=${f.loc}`).data;
  const joinQueue = (name) => customer.request(`/api/public/locations/${slug}/tickets`, { body: { name, serviceId: f.service }, headers: { "Idempotency-Key": randomUUID() } });
  let server, userId, first, servingId;
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true }); assert.equal(created.error, null); userId = created.data.user.id;
    sql(`insert into public.organizations(id,name) values ('${f.org}','Cookie regression');
      insert into public.managers(user_id,organization_id,name) values ('${userId}','${f.org}','Cookie manager');
      insert into public.locations(id,organization_id,name,slug) values ('${f.loc}','${f.org}','Cookie reception','${slug}');
      insert into public.services(id,organization_id,location_id,name,queue_prefix,default_service_minutes) values ('${f.service}','${f.org}','${f.loc}','Cookie service','C',5);
      insert into public.staff(id,organization_id,name,staff_code,pin_hash) values ('${f.staff}','${f.org}','Cookie staff','${code}',${literal(pinHash)});
      insert into public.staff_assignments(organization_id,staff_id,location_id,service_id) values ('${f.org}','${f.staff}','${f.loc}','${f.service}');`);
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3108"], {
      env: { ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, NEXT_PUBLIC_SUPABASE_URL: cfg.API_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: cfg.PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY, AUTH_RATE_LIMIT_SECRET: secret }, windowsHide: true, stdio: "ignore",
    });
    let ready = false;
    for (let i = 0; i < 80; i++) { if (server.exitCode !== null) throw new Error("Cookie test server failed; check port 3108."); try { if ((await fetch("http://127.0.0.1:3108")).status === 200) { ready = true; break; } } catch {} await delay(250); }
    assert.ok(ready);
    await t.test("native staff form sets a host-only root-path protected cookie that reaches queue APIs", () => {
      assert.match(browser.request("/staff/login").headers, /referrer-policy: same-origin/i);
      const login = staffLogin(); assert.equal(login.status, 303);
      for (const flag of [/__Host-queue-staff-session=/, /Path=\//, /HttpOnly/i, /Secure/i, /SameSite=lax/i]) assert.match(login.headers, flag);
      assert.doesNotMatch(login.headers, /;\s*Domain=/i);
      assert.deepEqual(browser.names(), ["__Host-queue-staff-session"]);
      assert.equal(browser.request("/staff/dashboard").status, 200); assert.equal(queue().status, 200);
    });
    await t.test("manager form login in the same cookie jar preserves the live staff session", () => {
      assert.equal(browser.request("/manager/login").status, 200); assert.equal(managerLogin().status, 303);
      assert.deepEqual(browser.names(), ["__Host-queue-manager-session", "__Host-queue-staff-session"]);
      for (const role of ["staff", "manager"]) {
        const session = browser.request(`/api/auth/session?role=${role}`); assert.equal(session.status, 200); assert.equal(session.data.session.role, role);
      }
      assert.equal(queue().status, 200); assert.equal(browser.request("/manager").status, 200);
      assert.equal(browser.request("/api/auth/session").status, 409);
      assert.equal(browser.request("/api/auth/logout", { body: {} }).status, 400);
    });
    await t.test("customer joins; CALL NEXT succeeds with both role cookies and updates public status and manager counts", () => {
      const joined = joinQueue("Cookie customer"); assert.equal(joined.status, 201); first = joined.data;
      assert.equal(queue().data.waiting[0].queueNumber, "C-001");
      assert.equal(status(first.token), "WAITING"); assert.equal(counts().waitingNow, 1);
      const called = action("call-next", { serviceId: f.service }); assert.equal(called.status, 200); servingId = called.data.ticket.id;
      assert.equal(status(first.token), "SERVING"); assert.deepEqual(counts(), { waitingNow: 0, currentlyServing: 1, servedToday: 0 });
      assert.equal(browser.request("/staff/dashboard").status, 200);
    });
    await t.test("COMPLETE uses the staff cookie and updates customer polling data and counts", () => {
      assert.equal(action("complete", { ticketId: servingId }).status, 200); assert.equal(status(first.token), "COMPLETED");
      assert.deepEqual(counts(), { waitingNow: 0, currentlyServing: 0, servedToday: 1 });
    });
    await t.test("SKIP uses the same session path without increasing served count", () => {
      const second = joinQueue("Skip customer"); assert.equal(second.status, 201);
      const called = action("call-next", { serviceId: f.service }); assert.equal(called.status, 200);
      assert.equal(status(second.data.token), "SERVING"); assert.equal(action("skip", { ticketId: called.data.ticket.id }).status, 200);
      assert.equal(status(second.data.token), "SKIPPED"); assert.equal(counts().servedToday, 1); assert.equal(counts().currentlyServing, 0);
    });
    await t.test("403 permission and Origin errors remain actionable and do not expire valid sessions", () => {
      for (const csrf of [null, "null", "https://foreign.invalid"]) {
        const denied = action("call-next", { serviceId: f.service }, { csrf }); assert.equal(denied.status, 403);
        assert.equal(staffResponseError(denied.status, denied.data.error).expired, false);
      }
      sql(`delete from public.staff_assignments where staff_id='${f.staff}';`);
      const denied = action("call-next", { serviceId: f.service }); assert.equal(denied.status, 403);
      const message = staffResponseError(denied.status, denied.data.error); assert.equal(message.expired, false); assert.match(message.message, /manager.*assignment/i);
      assert.equal(browser.request("/api/staff/queue").status, 200);
      sql(`insert into public.staff_assignments(organization_id,staff_id,location_id,service_id) values ('${f.org}','${f.staff}','${f.loc}','${f.service}');`);
      assert.equal(queue().status, 200);
    });
    await t.test("relogin rotates only its own role; explicit logout leaves the other tab authenticated", () => {
      assert.equal(staffLogin().status, 303); assert.equal(browser.request(`/api/manager/dashboard?locationId=${f.loc}`).status, 200);
      assert.equal(browser.request("/api/auth/logout?role=staff", { body: {} }).status, 200);
      assert.deepEqual(browser.names(), ["__Host-queue-manager-session"]);
      assert.equal(browser.request("/staff/dashboard").status, 307); assert.equal(browser.request(`/api/manager/dashboard?locationId=${f.loc}`).status, 200);
      assert.equal(staffLogin().status, 303);
      assert.equal(browser.request("/api/auth/logout?role=manager", { body: {} }).status, 200);
      assert.deepEqual(browser.names(), ["__Host-queue-staff-session"]); assert.equal(queue().status, 200); assert.equal(browser.request("/manager").status, 307);
    });
    await t.test("genuine staff expiry returns 401 even alongside a valid manager cookie", () => {
      assert.equal(managerLogin().status, 303);
      sql(`update private.app_sessions set created_at=now()-interval '9 hours', expires_at=now()-interval '1 hour' where staff_id='${f.staff}';`);
      const expired = queue(); assert.equal(expired.status, 401); assert.equal(staffResponseError(expired.status).expired, true);
      assert.equal(action("call-next", { serviceId: f.service }).status, 401);
      assert.equal(browser.request("/staff/dashboard").status, 307); assert.equal(browser.request(`/api/manager/dashboard?locationId=${f.loc}`).status, 200);
    });
    await t.test("conflicts and service outages are actionable without an expiry redirect", () => {
      for (const code of [400, 403, 409, 429, 500, 503]) { assert.equal(staffResponseError(code).expired, false); assert.match(staffResponseError(code).message, /refresh/i); }
    });
  } finally {
    if (server) { server.kill(); await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]); }
    browser.close(); customer.close();
    sql(`delete from private.auth_rate_limits where key_hash in (${keys.map(literal).join(",")});`);
    for (const table of ["queue_tickets", "service_daily_counters", "staff_assignments", "services", "staff", "locations", "managers"]) sql(`delete from public.${table} where organization_id='${f.org}';`);
    sql(`delete from public.organizations where id='${f.org}';`);
    if (userId) await admin.auth.admin.deleteUser(userId);
  }
});
