import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { hashPin, verifyPin } from "../lib/auth/pin.ts";

const container = "supabase_db_digital-queue-management-system";
const origin = "http://127.0.0.1:3100";
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
function sql(statement) {
  return execFileSync("docker", ["exec", "-i", container, "psql", "-X", "-qAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

test("authentication HTTP integration (real local Supabase, production Next.js)", { timeout: 180000 }, async (t) => {
  let status;
  try {
    assert.ok(process.env.npm_execpath, "Run tests with npm run test:auth.");
    const output = execFileSync(process.execPath, [process.env.npm_execpath,
      "exec", "--yes", "--package=supabase@2.117.0", "--", "supabase", "status", "-o", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    status = JSON.parse(output);
  } catch { throw new Error("Start the local Supabase Auth/API/database before running authentication tests."); }
  assert.equal(new URL(status.API_URL).hostname, "127.0.0.1", "Tests only run against loopback Supabase.");
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const secret = randomBytes(32).toString("hex");
  const fixture = {
    org: randomUUID(), otherOrg: randomUUID(), loc: randomUUID(), otherLoc: randomUUID(), siblingLoc: randomUUID(),
    service: randomUUID(), otherService: randomUUID(), siblingService: randomUUID(),
    staff: randomUUID(), coworker: randomUUID(), foreignStaff: randomUUID(),
  };
  const tag = randomBytes(6).toString("hex");
  const code = `STAFF_${tag.toUpperCase()}`;
  const coworkerCode = `COWORKER_${tag.toUpperCase()}`;
  const foreignCode = `FOREIGN_${tag.toUpperCase()}`;
  const email = `manager-${tag}@example.invalid`;
  const noMembershipEmail = `unassigned-${tag}@example.invalid`;
  const password = randomBytes(32).toString("base64url");
  const pin = String(randomInt(100000, 1000000));
  const pinHash = await hashPin(pin);
  const authUsers = [];
  const rateKeys = new Set();
  let server;
  let staffCookie;
  let managerCookie;
  let managerId;
  let childOutput = "";
  const addRateKey = (value) => rateKeys.add(createHmac("sha256", secret).update(value).digest("hex"));
  const clearRates = () => {
    if (rateKeys.size) sql(`delete from private.auth_rate_limits where key_hash in (${[...rateKeys].map(literal).join(",")});`);
  };
  const check = async (name, fn) => { clearRates(); await t.test(name, fn); };
  async function request(path, { method = "GET", body, cookie, csrfOrigin = origin } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (method === "POST") { headers.origin = csrfOrigin; headers["content-type"] = "application/json"; }
    if (path.includes("/login") && method === "POST") {
      const role = path.includes("/staff/") ? "staff" : "manager";
      const id = role === "staff" ? (body?.staffCode ?? "").trim().toUpperCase() : (body?.email ?? "").trim().toLowerCase();
      addRateKey("ip:shared-origin"); addRateKey(`${role}:account:${id.slice(0, 254)}`);
    }
    const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    return { response, data, text, cookie: response.headers.getSetCookie()[0]?.split(";")[0] };
  }
  const staffLogin = (staffCode = code, providedPin = pin, cookie) => request("/api/auth/staff/login", { method: "POST", body: { staffCode, pin: providedPin }, cookie });
  const managerLogin = (providedPassword = password) => request("/api/auth/manager/login", { method: "POST", body: { email, password: providedPassword } });
  const session = (cookie) => request("/api/auth/session", { cookie });
  const action = (name, body, cookie = staffCookie) => request(`/api/staff/queue/${name}`, { method: "POST", body, cookie });
  async function ticket() {
    const { data, error } = await admin.rpc("create_queue_ticket", { p_location_id: fixture.loc, p_service_id: fixture.service, p_customer_name: "Auth test customer" });
    assert.equal(error, null); return data;
  }

  try {
    for (const accountEmail of [email, noMembershipEmail]) {
      const { data, error } = await admin.auth.admin.createUser({ email: accountEmail, password, email_confirm: true });
      assert.equal(error, null); authUsers.push(data.user.id);
    }
    managerId = authUsers[0];
    sql(`
      insert into public.organizations(id,name) values ('${fixture.org}','Auth tests'),('${fixture.otherOrg}','Other auth tests');
      insert into public.managers(user_id,organization_id,name) values ('${managerId}','${fixture.org}','Test manager');
      insert into public.locations(id,organization_id,name,slug) values
        ('${fixture.loc}','${fixture.org}','Auth location','auth-${tag}'),
        ('${fixture.otherLoc}','${fixture.otherOrg}','Foreign location','foreign-${tag}'),
        ('${fixture.siblingLoc}','${fixture.org}','Unassigned location','sibling-${tag}');
      insert into public.services(id,organization_id,location_id,name,queue_prefix,default_service_minutes) values
        ('${fixture.service}','${fixture.org}','${fixture.loc}','Auth service','A',5),
        ('${fixture.otherService}','${fixture.otherOrg}','${fixture.otherLoc}','Foreign service','A',5),
        ('${fixture.siblingService}','${fixture.org}','${fixture.siblingLoc}','Unassigned service','A',5);
      insert into public.staff(id,organization_id,name,staff_code,pin_hash) values
        ('${fixture.staff}','${fixture.org}','Auth staff','${code}',${literal(pinHash)}),
        ('${fixture.coworker}','${fixture.org}','Coworker','${coworkerCode}',${literal(pinHash)}),
        ('${fixture.foreignStaff}','${fixture.otherOrg}','Foreign staff','${foreignCode}',${literal(pinHash)});
      insert into public.staff_assignments(organization_id,staff_id,location_id,service_id) values
        ('${fixture.org}','${fixture.staff}','${fixture.loc}','${fixture.service}'),
        ('${fixture.org}','${fixture.coworker}','${fixture.loc}','${fixture.service}'),
        ('${fixture.otherOrg}','${fixture.foreignStaff}','${fixture.otherLoc}','${fixture.otherService}');
    `);
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], {
      env: { ...process.env, NODE_ENV: "production", APP_ORIGIN: origin,
        NEXT_PUBLIC_SUPABASE_URL: status.API_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY,
        SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, AUTH_RATE_LIMIT_SECRET: secret },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { childOutput += chunk; });
    server.stderr.on("data", (chunk) => { childOutput += chunk; });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (server.exitCode !== null) throw new Error("Test application could not start; check port 3100.");
      try { if ((await fetch(origin)).status === 200) { ready = true; break; } } catch {}
      await delay(250);
    }
    assert.ok(ready, "Test server starts.");

    await check("strong salted PIN hashing and wrong/unknown credential verification", async () => {
      assert.match(pinHash, /^\$scrypt\$ln=17,r=8,p=1\$/);
      assert.notEqual(await hashPin(pin), pinHash);
      assert.equal(await verifyPin(pin, pinHash), true);
      assert.equal(await verifyPin("wrong", pinHash), false);
      assert.equal(await verifyPin(pin, null), false);
    });
    await check("unauthenticated pages redirect and protected APIs reject", async () => {
      for (const role of ["staff", "manager"]) {
        assert.equal((await request(`/${role}/login`)).response.status, 200);
        const page = await request(`/${role}`);
        assert.equal(page.response.status, 307);
        assert.equal(new URL(page.response.headers.get("location"), origin).pathname, `/${role}/login`);
      }
      assert.equal((await session()).response.status, 401);
      assert.equal((await action("call-next", { serviceId: fixture.service }, undefined)).response.status, 401);
      assert.equal((await request("/api/manager/locations")).response.status, 401);
    });
    await check("invalid Staff ID and invalid PIN return identical generic responses", async () => {
      const unknown = await staffLogin(`MISSING_${tag}`, pin);
      const wrong = await staffLogin(code, pin === "000000" ? "111111" : "000000");
      assert.equal(unknown.response.status, 401); assert.equal(wrong.response.status, 401);
      assert.deepEqual(unknown.data, wrong.data);
      assert.equal(unknown.cookie, undefined); assert.equal(wrong.cookie, undefined);
    });
    await check("actual login pages preserve native form Origin and both URL-encoded logins succeed", async () => {
      for (const role of ["manager", "staff"]) {
        const page = await request(`/${role}/login`);
        // A native navigation POST under no-referrer sends Origin: null. A
        // JSON fetch with an explicitly injected Origin would miss this defect.
        assert.equal(page.response.headers.get("referrer-policy"), "same-origin");
        const form = page.text.match(/<form\b[^>]*>/)?.[0]; assert.ok(form);
        assert.match(form, /method="post"/);
        const action = form.match(/action="([^"]+)"/)?.[1]; assert.equal(action, `/api/auth/${role}/login`);
        const body = role === "manager" ? { email, password } : { staffCode: code, pin };
        for (const field of Object.keys(body)) assert.ok(page.text.includes(`name="${field}"`));
        addRateKey("ip:shared-origin"); addRateKey(`${role}:account:${role === "manager" ? email : code}`);
        const logged = await fetch(new URL(action, origin), { method: "POST", redirect: "manual",
          headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
        assert.equal(logged.status, 303);
        const cookie = logged.headers.getSetCookie()[0]?.split(";")[0]; assert.ok(cookie);
        assert.equal((await session(cookie)).data.session.role, role);
        const destination = new URL(logged.headers.get("location"), origin).pathname;
        assert.equal(destination, role === "staff" ? "/staff/dashboard" : "/manager");
        const dashboard = await request(destination, { cookie }); assert.equal(dashboard.response.status, 200);
        assert.equal(dashboard.response.headers.get("referrer-policy"), "same-origin");
        const logout = await fetch(`${origin}/api/auth/logout`, { method: "POST", redirect: "manual", headers: { origin, cookie, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" }, body: "" });
        assert.equal(logout.status, 303); assert.equal((await session(cookie)).response.status, 401);
      }
    });
    await check("production login rejects null, missing, foreign, alternate-host and cross-site origins", async () => {
      for (const role of ["manager", "staff"]) for (const candidate of [null, "null", "https://evil.invalid", "http://localhost:3100", origin]) {
        const headers = { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": candidate === origin ? "cross-site" : "same-origin" };
        if (candidate !== null) headers.origin = candidate;
        const body = new URLSearchParams(role === "manager" ? { email, password } : { staffCode: code, pin });
        const result = await fetch(`${origin}/api/auth/${role}/login`, { method: "POST", headers, body, redirect: "manual" });
        assert.equal(result.status, 403); assert.deepEqual(await result.json(), { error: "Request origin is not allowed." });
        assert.equal(result.headers.getSetCookie().length, 0);
      }
    });
    await check("valid staff login creates a secure opaque cookie and scoped session", async () => {
      const result = await staffLogin(code.toLowerCase());
      assert.equal(result.response.status, 200); assert.deepEqual(result.data, { ok: true });
      staffCookie = result.cookie;
      const header = result.response.headers.getSetCookie()[0];
      for (const flag of ["HttpOnly", "Secure", "SameSite=lax", "Path=/", "__Host-queue-staff-session="]) assert.ok(header.includes(flag));
      assert.ok(!header.includes("Domain="));
      const value = staffCookie.split("=")[1];
      assert.match(value, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(sql(`select count(*) from private.app_sessions where token_hash='${digest(value)}';`), "1");
      const authenticated = await session(staffCookie);
      assert.equal(authenticated.data.session.id, fixture.staff);
      assert.equal(authenticated.data.session.role, "staff");
      assert.equal(authenticated.data.session.organizationId, fixture.org);
      assert.deepEqual(authenticated.data.session.assignments, [{ locationId: fixture.loc, serviceId: fixture.service }]);
      assert.ok(!authenticated.text.includes(pinHash));
      assert.equal((await request("/staff", { cookie: staffCookie })).response.status, 200);
    });
    await check("login rotates sessions and revokes the previous cookie", async () => {
      const previous = staffCookie;
      const result = await staffLogin(code, pin, previous);
      assert.equal(result.response.status, 200); staffCookie = result.cookie;
      assert.notEqual(previous, staffCookie);
      assert.equal((await session(previous)).response.status, 401);
    });
    await check("valid manager login uses Supabase Auth and organization membership", async () => {
      const result = await managerLogin();
      assert.equal(result.response.status, 200); managerCookie = result.cookie;
      const current = (await session(managerCookie)).data.session;
      assert.equal(current.id, managerId); assert.equal(current.role, "manager");
      assert.equal(current.organizationId, fixture.org);
      assert.ok(!result.text.includes("access_token") && !result.text.includes("refresh_token"));
      assert.equal((await request("/manager", { cookie: managerCookie })).response.status, 200);
    });
    await check("wrong manager password and missing manager membership are rejected", async () => {
      assert.equal((await managerLogin("wrong-password")).response.status, 401);
      const result = await request("/api/auth/manager/login", { method: "POST", body: { email: noMembershipEmail, password } });
      assert.equal(result.response.status, 401); assert.equal(result.cookie, undefined);
    });
    await check("roles and manager organization cannot be spoofed", async () => {
      assert.equal((await request("/api/manager/locations", { cookie: staffCookie })).response.status, 403);
      assert.equal((await action("call-next", { serviceId: fixture.service }, managerCookie)).response.status, 403);
      assert.equal((await request("/staff", { cookie: managerCookie })).response.status, 307);
      assert.equal((await request("/manager", { cookie: staffCookie })).response.status, 307);
      const own = await request("/api/manager/locations", { cookie: managerCookie });
      assert.deepEqual(own.data.locations.map((item) => item.id).sort(), [fixture.loc, fixture.siblingLoc].sort());
      assert.equal((await request(`/api/manager/locations?locationId=${fixture.otherLoc}`, { cookie: managerCookie })).response.status, 404);
      assert.equal((await request(`/api/manager/locations?organizationId=${fixture.otherOrg}`, { cookie: managerCookie })).response.status, 400);
    });
    await check("staff cannot impersonate another staff member or use unassigned services", async () => {
      assert.equal((await action("call-next", { serviceId: fixture.service, staffId: fixture.coworker })).response.status, 400);
      assert.equal((await action("call-next", { serviceId: fixture.otherService })).response.status, 403);
      assert.equal((await action("call-next", { serviceId: fixture.siblingService })).response.status, 403);
    });
    await check("trusted queue routes call existing RPCs and enforce ticket ownership", async () => {
      const created = await ticket();
      const called = await action("call-next", { serviceId: fixture.service });
      assert.equal(called.response.status, 200); assert.equal(called.data.ticket.id, created.id);
      assert.ok(!called.text.includes(created.ticket_token));
      assert.equal(sql(`select served_by_staff_id from public.queue_tickets where id='${created.id}';`), fixture.staff);
      const coworker = (await staffLogin(coworkerCode)).cookie;
      for (const operation of ["complete", "skip"]) {
        assert.equal((await action(operation, { ticketId: created.id }, coworker)).response.status, 403);
      }
      assert.equal((await action("complete", { ticketId: created.id })).data.ticket.status, "COMPLETED");
      await ticket();
      const next = (await action("call-next", { serviceId: fixture.service })).data.ticket;
      assert.equal((await action("skip", { ticketId: next.id })).data.ticket.status, "SKIPPED");
    });
    await check("assignment revocation takes effect on the existing session", async () => {
      sql(`delete from public.staff_assignments where staff_id='${fixture.staff}';`);
      assert.deepEqual((await session(staffCookie)).data.session.assignments, []);
      assert.equal((await action("call-next", { serviceId: fixture.service })).response.status, 403);
      sql(`insert into public.staff_assignments(organization_id,staff_id,location_id,service_id) values ('${fixture.org}','${fixture.staff}','${fixture.loc}','${fixture.service}');`);
    });
    await check("CSRF, missing Origin, and oversized login bodies are rejected", async () => {
      assert.equal((await request("/api/auth/logout", { method: "POST", cookie: staffCookie, csrfOrigin: "https://evil.invalid" })).response.status, 403);
      const absent = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { cookie: staffCookie } });
      assert.equal(absent.status, 403);
      assert.equal((await request("/api/auth/staff/login", { method: "POST", body: { staffCode: code, pin: "1".repeat(5000) } })).response.status, 413);
      assert.equal((await session(staffCookie)).response.status, 200);
    });
    await check("invalid and expired sessions fail on APIs and pages", async () => {
      const invalid = `__Host-queue-staff-session=${randomBytes(32).toString("base64url")}`;
      assert.equal((await session(invalid)).response.status, 401);
      assert.equal((await request("/staff", { cookie: invalid })).response.status, 307);
      const hash = digest(staffCookie.split("=")[1]);
      sql(`update private.app_sessions set created_at=now()-interval '9 hours',expires_at=now()-interval '1 hour' where token_hash='${hash}';`);
      assert.equal((await session(staffCookie)).response.status, 401);
      staffCookie = (await staffLogin()).cookie;
    });
    await check("staff deactivation permanently revokes sessions", async () => {
      sql(`update public.staff set active=false where id='${fixture.staff}';`);
      assert.equal((await session(staffCookie)).response.status, 401);
      assert.equal((await staffLogin()).response.status, 401);
      sql(`update public.staff set active=true where id='${fixture.staff}';`);
      assert.equal((await session(staffCookie)).response.status, 401);
      staffCookie = (await staffLogin()).cookie;
    });
    await check("PIN change revokes staff sessions", async () => {
      sql(`update public.staff set pin_hash=${literal(await hashPin(pin))} where id='${fixture.staff}';`);
      assert.equal((await session(staffCookie)).response.status, 401);
      staffCookie = (await staffLogin()).cookie;
    });
    await check("manager organization change permanently revokes sessions", async () => {
      sql(`update public.managers set organization_id='${fixture.otherOrg}' where user_id='${managerId}';`);
      assert.equal((await session(managerCookie)).response.status, 401);
      sql(`update public.managers set organization_id='${fixture.org}' where user_id='${managerId}';`);
      assert.equal((await session(managerCookie)).response.status, 401);
      managerCookie = (await managerLogin()).cookie;
    });
    await check("manager password change revokes sessions", async () => {
      const { error } = await admin.auth.admin.updateUserById(managerId, { password: randomBytes(32).toString("base64url") });
      assert.equal(error, null); assert.equal((await session(managerCookie)).response.status, 401);
    });
    await check("manager logout revokes access and ban/unban cannot resurrect a session", async () => {
      const reset = await admin.auth.admin.updateUserById(managerId, { password });
      assert.equal(reset.error, null);
      managerCookie = (await managerLogin()).cookie;
      assert.ok(managerCookie);
      assert.equal((await request("/api/auth/logout", { method: "POST", cookie: managerCookie })).response.status, 200);
      assert.equal((await session(managerCookie)).response.status, 401);
      managerCookie = (await managerLogin()).cookie;
      const banned = await admin.auth.admin.updateUserById(managerId, { ban_duration: "1h" });
      assert.equal(banned.error, null);
      assert.equal((await session(managerCookie)).response.status, 401);
      const unbanned = await admin.auth.admin.updateUserById(managerId, { ban_duration: "none" });
      assert.equal(unbanned.error, null);
      assert.equal((await session(managerCookie)).response.status, 401);
    });
    await check("logout deletes the session and replay no longer grants access", async () => {
      const result = await request("/api/auth/logout", { method: "POST", cookie: staffCookie });
      assert.equal(result.response.status, 200);
      assert.ok(result.response.headers.getSetCookie()[0].includes("Max-Age=0"));
      assert.equal((await session(staffCookie)).response.status, 401);
      assert.equal((await action("call-next", { serviceId: fixture.service })).response.status, 401);
      assert.equal((await request("/api/auth/logout")).response.status, 405);
    });
    await check("database-backed login throttling blocks the sixth attempt", async () => {
      for (let i = 0; i < 5; i++) assert.equal((await staffLogin(`LIMIT_${tag}`, "000000")).response.status, 401);
      const limited = await staffLogin(`LIMIT_${tag}`, "000000");
      assert.equal(limited.response.status, 429); assert.equal(limited.response.headers.get("retry-after"), "900");
      assert.equal(limited.cookie, undefined);
    });
    await check("browser roles cannot access session storage or session RPCs", () => {
      for (const role of ["anon", "authenticated"]) {
        assert.equal(sql(`select has_function_privilege('${role}','public.issue_app_session(text,text,uuid,text,text)','EXECUTE');`), "f");
        assert.equal(sql(`select has_function_privilege('${role}','public.perform_staff_queue_action(text,text,uuid,uuid)','EXECUTE');`), "f");
        assert.equal(sql(`select has_table_privilege('${role}','private.app_sessions','SELECT');`), "f");
        assert.equal(sql(`select has_table_privilege('${role}','private.auth_rate_limits','UPDATE');`), "f");
      }
    });
    await check("browser bundles contain no privileged Supabase credentials or admin client", () => {
      const files = readdirSync(".next/static", { recursive: true }).filter((name) => name.endsWith(".js"));
      assert.ok(files.length);
      for (const name of files) {
        const content = readFileSync(join(".next/static", name), "utf8");
        assert.ok(!content.includes(status.SERVICE_ROLE_KEY) && !content.includes("SUPABASE_SERVICE_ROLE_KEY"));
      }
    });
    assert.ok(!childOutput.includes(password) && !childOutput.includes(pinHash), "Credentials are not logged.");
  } finally {
    if (server) {
      server.kill();
      await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]);
    }
    clearRates();
    for (const table of ["queue_tickets", "service_daily_counters", "staff_assignments", "services", "staff", "locations", "managers"]) {
      sql(`delete from public.${table} where organization_id in ('${fixture.org}','${fixture.otherOrg}');`);
    }
    sql(`delete from public.organizations where id in ('${fixture.org}','${fixture.otherOrg}');`);
    for (const id of authUsers) await admin.auth.admin.deleteUser(id);
  }
});
