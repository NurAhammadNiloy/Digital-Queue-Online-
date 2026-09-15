import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import { hashPin, verifyPin } from "../lib/auth/pin.ts";

const origin = "http://127.0.0.1:3101";
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
function sql(statement) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_digital-queue-management-system", "psql", "-X", "-qAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

test("manager staff management (real PostgreSQL, Auth and production HTTP routes)", { timeout: 240000 }, async (t) => {
  assert.ok(process.env.npm_execpath, "Run with npm run test:staff.");
  const status = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "exec", "--yes", "--package=supabase@2.117.0", "--", "supabase", "status", "-o", "json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(new URL(status.API_URL).hostname, "127.0.0.1", "Only local Supabase is allowed.");
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const anonymous = createClient(status.API_URL, status.PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const secret = randomBytes(32).toString("hex");
  const f = Object.fromEntries(["org", "otherOrg", "loc", "otherLoc", "siblingLoc", "service", "otherService", "siblingService"].map((key) => [key, randomUUID()]));
  const tag = randomBytes(6).toString("hex");
  let code = `PROVISION_${tag.toUpperCase()}`;
  const pin = "493728", nextPin = "826193";
  const password = randomBytes(32).toString("base64url");
  const emails = [`provision-${tag}@example.invalid`, `foreign-provision-${tag}@example.invalid`];
  const users = [], cookies = [], rateKeys = new Set();
  let server, output = "", staffId, foreignId, staffCookie, disabledCookie;
  const assignment = { locationId: f.loc, serviceId: f.service };
  const sibling = { locationId: f.siblingLoc, serviceId: f.siblingService };
  const foreign = { locationId: f.otherLoc, serviceId: f.otherService };
  const rateKey = (value) => rateKeys.add(createHmac("sha256", secret).update(value).digest("hex"));
  const clearRates = () => { if (rateKeys.size) sql(`delete from private.auth_rate_limits where key_hash in (${[...rateKeys].map(literal).join(",")});`); };
  const check = async (name, fn) => { clearRates(); await t.test(name, fn); };
  async function request(path, { method = "GET", body, cookie, csrfOrigin = origin } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (method !== "GET") { headers.origin = csrfOrigin; headers["content-type"] = "application/json"; }
    if (path.endsWith("/login") && method === "POST") {
      const role = path.includes("/staff/") ? "staff" : "manager";
      const id = role === "staff" ? (body.staffCode ?? "").trim().toUpperCase() : body.email.trim().toLowerCase();
      rateKey("ip:shared-origin"); rateKey(`${role}:account:${id}`);
    }
    const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    return { response, data, text, cookie: response.headers.getSetCookie()[0]?.split(";")[0] };
  }
  const create = (body, cookie = cookies[0]) => request("/api/manager/staff", { method: "POST", body, cookie });
  const profile = (extra = {}) => ({ name: "Provisioned staff", staffCode: code, pin, assignments: [assignment], ...extra });
  const update = (body, id = staffId, cookie = cookies[0]) => request(`/api/manager/staff/${id}`, { method: "PUT", body, cookie });
  const change = (kind, body, id = staffId, cookie = cookies[0]) => request(`/api/manager/staff/${id}/${kind}`, { method: "POST", body, cookie });
  const login = (providedPin = pin, staffCode = code) => request("/api/auth/staff/login", { method: "POST", body: { staffCode, pin: providedPin } });
  const session = (cookie) => request("/api/auth/session", { cookie });
  const staffRow = (id = staffId) => JSON.parse(sql(`select row_to_json(s) from public.staff s where id=${literal(id)};`));
  const get = (id = staffId, cookie = cookies[0]) => request(`/api/manager/staff/${id}`, { cookie });
  try {
    for (const email of emails) {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      assert.equal(error, null); users.push(data.user.id);
    }
    sql(`insert into public.organizations(id,name) values ('${f.org}','Provisioning tests'),('${f.otherOrg}','Foreign provisioning');
      insert into public.managers(user_id,organization_id,name) values ('${users[0]}','${f.org}','Manager'),('${users[1]}','${f.otherOrg}','Other manager');
      insert into public.locations(id,organization_id,name,slug) values
        ('${f.loc}','${f.org}','Primary location','provision-${tag}'),('${f.siblingLoc}','${f.org}','Second location','provision-second-${tag}'),
        ('${f.otherLoc}','${f.otherOrg}','Foreign location','provision-foreign-${tag}');
      insert into public.services(id,organization_id,location_id,name,queue_prefix,default_service_minutes) values
        ('${f.service}','${f.org}','${f.loc}','Primary service','A',5),('${f.siblingService}','${f.org}','${f.siblingLoc}','Second service','B',5),
        ('${f.otherService}','${f.otherOrg}','${f.otherLoc}','Foreign service','A',5);`);
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3101"], {
      env: { ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, AUTH_RATE_LIMIT_SECRET: secret },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { output += chunk; }); server.stderr.on("data", (chunk) => { output += chunk; });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (server.exitCode !== null) throw new Error("Application failed to start; check port 3101.");
      try { if ((await fetch(origin)).status === 200) { ready = true; break; } } catch {}
      await delay(250);
    }
    assert.ok(ready);
    for (const email of emails) {
      const result = await request("/api/auth/manager/login", { method: "POST", body: { email, password } });
      assert.equal(result.response.status, 200); cookies.push(result.cookie);
    }

    await check("unauthenticated management APIs and all management pages are protected", async () => {
      const id = randomUUID();
      for (const [path, method] of [["/api/manager/staff", "GET"], ["/api/manager/staff", "POST"], [`/api/manager/staff/${id}`, "GET"], [`/api/manager/staff/${id}`, "PUT"], [`/api/manager/staff/${id}/pin`, "POST"], [`/api/manager/staff/${id}/status`, "POST"]]) {
        assert.equal((await request(path, { method, body: method === "GET" ? undefined : {} })).response.status, 401);
      }
      for (const path of ["/manager/staff", "/manager/staff/new", `/manager/staff/${id}`]) {
        const result = await request(path); assert.equal(result.response.status, 307);
        assert.equal(new URL(result.response.headers.get("location"), origin).pathname, "/manager/login");
      }
    });
    await check("manager creates staff with normalized ID and atomic location/service assignments", async () => {
      const result = await create(profile({ staffCode: `  ${code.toLowerCase()}  `, assignments: [assignment, sibling] }));
      assert.equal(result.response.status, 201, result.text); staffId = result.data.id;
      assert.deepEqual(Object.keys(result.data), ["id"]);
      const row = staffRow(); assert.equal(row.organization_id, f.org); assert.equal(row.staff_code, code); assert.equal(row.active, true);
      assert.notEqual(row.pin_hash, pin); assert.equal(await verifyPin(pin, row.pin_hash), true);
      const read = await get(); assert.equal(read.response.status, 200);
      assert.deepEqual(new Set(read.data.staff.assignments.map((a) => a.serviceId)), new Set([f.service, f.siblingService]));
      const logged = await login(); assert.equal(logged.response.status, 200); staffCookie = logged.cookie;
    });
    await check("manager can generate a Staff ID and create staff without queue permissions", async () => {
      const result = await create(profile({ staffCode: "", assignments: [] }));
      assert.equal(result.response.status, 201, result.text);
      const staff = (await get(result.data.id)).data.staff;
      assert.match(staff.staffCode, /^S[1-9][0-9]{3,}$/); assert.deepEqual(staff.assignments, []);
    });
    await check("duplicate normalized Staff IDs return a clean non-disclosing conflict across tenants", async () => {
      const own = await create(profile({ staffCode: code.toLowerCase() }));
      const other = await create(profile({ assignments: [foreign] }), cookies[1]);
      assert.equal(own.response.status, 409); assert.equal(other.response.status, 409);
      assert.deepEqual(own.data, { error: "Staff ID is unavailable. Choose another." }); assert.deepEqual(other.data, own.data);
      assert.equal(sql(`select count(*) from public.staff where staff_code='${code}';`), "1");
    });
    await check("concurrent attempts at one global Staff ID create exactly one account", async () => {
      const body = profile({ staffCode: `RACE_${tag}`, assignments: [] });
      const results = await Promise.all([create(body), create(body)]);
      assert.deepEqual(results.map((r) => r.response.status).sort(), [201, 409]);
    });
    await check("browser organization, role, identity and credential-hash overrides are rejected", async () => {
      for (const extra of [{ organizationId: f.otherOrg }, { organization_id: f.otherOrg }, { staffId: randomUUID() }, { role: "manager" }, { pin_hash: "plaintext" }]) {
        assert.equal((await create(profile(extra))).response.status, 400);
      }
      assert.equal((await request(`/api/manager/staff?organizationId=${f.otherOrg}`, { cookie: cookies[0] })).response.status, 400);
    });
    await check("foreign locations, foreign services and mismatched service/location pairs cannot be assigned", async () => {
      for (const pair of [{ locationId: f.otherLoc, serviceId: f.service }, { locationId: f.loc, serviceId: f.otherService }, foreign, { locationId: f.siblingLoc, serviceId: f.service }]) {
        const result = await create(profile({ staffCode: `BAD_${tag}`, assignments: [assignment, pair] }));
        // Duplicate service inputs are rejected before the transaction; other invalid pairs fail authorization.
        assert.ok([400, 403].includes(result.response.status), result.text);
      }
      assert.equal(sql(`select count(*) from public.staff where staff_code='BAD_${tag.toUpperCase()}';`), "0");
    });
    await check("profile input validation rejects malformed, duplicate and oversized assignments and invalid PINs", async () => {
      await assert.rejects(hashPin("123456\n"), /PIN must contain/);
      for (const extra of [{ name: "  " }, { staffCode: "a b" }, { pin: "123" }, { pin: 123456 }, { pin: "123456\n" }, { pin: "1234567890123" }, { assignments: [assignment, assignment] }, { assignments: [{ ...assignment, role: "manager" }] }, { assignments: [{ serviceId: "invalid" }] }, { assignments: {} }]) {
        assert.equal((await create(profile(extra))).response.status, 400);
      }
      assert.equal((await create(profile({ name: "x".repeat(5000) }))).response.status, 413);
    });
    await check("staff role cannot list, create, edit, reset or disable accounts", async () => {
      for (const [path, method] of [["/api/manager/staff", "GET"], ["/api/manager/staff", "POST"], [`/api/manager/staff/${staffId}`, "GET"], [`/api/manager/staff/${staffId}`, "PUT"], [`/api/manager/staff/${staffId}/pin`, "POST"], [`/api/manager/staff/${staffId}/status`, "POST"]]) {
        assert.equal((await request(path, { method, cookie: staffCookie, body: method === "GET" ? undefined : {} })).response.status, 403);
      }
      assert.equal((await request("/manager/staff", { cookie: staffCookie })).response.status, 307);
    });
    await check("all manager mutation routes enforce same-origin CSRF checks", async () => {
      for (const [path, method] of [["/api/manager/staff", "POST"], [`/api/manager/staff/${staffId}`, "PUT"], [`/api/manager/staff/${staffId}/pin`, "POST"], [`/api/manager/staff/${staffId}/status`, "POST"]]) {
        assert.equal((await request(path, { method, body: {}, cookie: cookies[0], csrfOrigin: "https://attacker.invalid" })).response.status, 403);
      }
    });
    await check("manager cannot view or modify another organization's staff", async () => {
      const created = await create(profile({ staffCode: `FOREIGN_${tag}`, assignments: [foreign] }), cookies[1]);
      assert.equal(created.response.status, 201); foreignId = created.data.id;
      assert.equal((await get(foreignId)).response.status, 404);
      assert.equal((await update({ name: "Attack", staffCode: `OTHER_${tag}`, assignments: [] }, foreignId)).response.status, 404);
      assert.equal((await change("pin", { pin: nextPin }, foreignId)).response.status, 404);
      assert.equal((await change("status", { active: false }, foreignId)).response.status, 404);
      assert.equal(staffRow(foreignId).organization_id, f.otherOrg); assert.equal(staffRow(foreignId).active, true);
      assert.equal((await request(`/manager/staff/${foreignId}`, { cookie: cookies[0] })).response.status, 404);
      const listed = await request("/api/manager/staff", { cookie: cookies[0] });
      assert.ok(listed.data.staff.some((s) => s.id === staffId)); assert.ok(!listed.data.staff.some((s) => s.id === foreignId));
    });
    await check("manager edits metadata and permissions, retaining unchanged assignment records", async () => {
      const prior = sql(`select id from public.staff_assignments where staff_id='${staffId}' and service_id='${f.siblingService}';`);
      const result = await update({ name: "Updated staff", staffCode: code.toLowerCase(), assignments: [sibling] });
      assert.equal(result.response.status, 200, result.text);
      const current = (await get()).data.staff; assert.equal(current.name, "Updated staff"); assert.equal(current.staffCode, code);
      assert.deepEqual(current.assignments, [sibling]);
      assert.equal(sql(`select id from public.staff_assignments where staff_id='${staffId}' and service_id='${f.siblingService}';`), prior);
    });
    await check("failed assignment edits roll back metadata and all permission changes", async () => {
      const before = (await get()).data.staff;
      const result = await update({ name: "Must roll back", staffCode: `ROLLBACK_${tag}`, assignments: [assignment, foreign] });
      assert.equal(result.response.status, 403); assert.deepEqual((await get()).data.staff, before);
    });
    await check("existing staff sessions immediately use new location/service permissions", async () => {
      const current = await session(staffCookie); assert.equal(current.response.status, 200); assert.deepEqual(current.data.session.assignments, [sibling]);
      const old = await request("/api/staff/queue/call-next", { method: "POST", cookie: staffCookie, body: { serviceId: f.service } });
      assert.equal(old.response.status, 403);
      const allowed = await request("/api/staff/queue/call-next", { method: "POST", cookie: staffCookie, body: { serviceId: f.siblingService } });
      assert.equal(allowed.response.status, 200);
    });
    await check("Staff ID edits enforce global uniqueness and switch the login identifier", async () => {
      const before = (await get()).data.staff;
      assert.equal((await update({ name: "Must roll back", staffCode: `FOREIGN_${tag}`, assignments: [] })).response.status, 409);
      assert.deepEqual((await get()).data.staff, before);
      const oldCode = code;
      const nextCode = `RENAMED_${tag.toUpperCase()}`;
      assert.equal((await update({ name: before.name, staffCode: nextCode.toLowerCase(), assignments: before.assignments })).response.status, 200);
      code = nextCode;
      assert.equal((await login(pin, oldCode)).response.status, 401);
      const result = await login(); assert.equal(result.response.status, 200);
      assert.equal((await session(staffCookie)).response.status, 200);
      // Keep the two-session reset test independent of this login.
      assert.equal((await request("/api/auth/logout", { method: "POST", cookie: result.cookie })).response.status, 200);
    });
    await check("manager reset replaces the hash and immediately revokes every active staff session", async () => {
      const second = (await login()).cookie; assert.ok(second);
      assert.equal(sql(`select count(*) from private.app_sessions where staff_id='${staffId}';`), "2");
      const oldHash = staffRow().pin_hash;
      const result = await change("pin", { pin: nextPin }); assert.equal(result.response.status, 200, result.text);
      const newHash = staffRow().pin_hash; assert.notEqual(oldHash, newHash); assert.equal(await verifyPin(nextPin, newHash), true);
      assert.equal(sql(`select count(*) from private.app_sessions where staff_id='${staffId}';`), "0");
      for (const cookie of [staffCookie, second]) assert.equal((await session(cookie)).response.status, 401);
    });
    await check("old PIN stops working and current PIN creates a fresh session", async () => {
      assert.equal((await login()).response.status, 401);
      const result = await login(nextPin); assert.equal(result.response.status, 200); staffCookie = result.cookie;
    });
    await check("disabling invalidates all existing sessions and blocks login", async () => {
      const second = (await login(nextPin)).cookie;
      assert.equal((await change("status", { active: false })).response.status, 200);
      assert.equal(staffRow().active, false);
      for (const cookie of [staffCookie, second]) assert.equal((await session(cookie)).response.status, 401);
      assert.equal((await login(nextPin)).response.status, 401);
      assert.equal(sql(`select count(*) from private.app_sessions where staff_id='${staffId}';`), "0"); disabledCookie = staffCookie;
    });
    await check("re-enabled staff use current credentials; revoked cookies never resurrect", async () => {
      assert.equal((await change("status", { active: true })).response.status, 200);
      assert.equal((await session(disabledCookie)).response.status, 401);
      assert.equal((await login()).response.status, 401);
      const result = await login(nextPin); assert.equal(result.response.status, 200); staffCookie = result.cookie;
    });
    await check("browser responses and rendered forms never include hashes, credentials or foreign options", async () => {
      const hash = staffRow().pin_hash;
      for (const path of ["/api/manager/staff", `/api/manager/staff/${staffId}`, "/manager/staff", "/manager/staff/new", `/manager/staff/${staffId}`]) {
        const result = await request(path, { cookie: cookies[0] }); assert.equal(result.response.status, 200);
        for (const forbidden of [hash, "pin_hash", password, status.SERVICE_ROLE_KEY, f.otherLoc, f.otherService]) assert.ok(!result.text.includes(forbidden));
        assert.match(result.response.headers.get("cache-control"), /no-store/);
      }
      const page = await request(`/manager/staff/${staffId}`, { cookie: cookies[0] });
      assert.ok(page.text.includes('type="password"')); assert.ok(page.text.includes("Reset PIN and sign out staff"));
      const denied = await anonymous.from("staff").select("pin_hash"); assert.ok(denied.error);
      const authClient = createClient(status.API_URL, status.PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      try {
        assert.equal((await authClient.auth.signInWithPassword({ email: emails[0], password })).error, null);
        assert.ok((await authClient.from("staff").select("pin_hash")).error);
        const metadata = await authClient.from("staff").select("id,name"); assert.equal(metadata.error, null);
        assert.ok(!metadata.data.some((s) => s.id === foreignId));
      } finally { await authClient.auth.signOut(); }
    });
    await check("new database RPC is service-only and rejects expired, invalid and staff sessions directly", async () => {
      const signature = "public.manage_staff(text,text,uuid,text,text,text,jsonb,boolean)";
      for (const role of ["anon", "authenticated"]) assert.equal(sql(`select has_function_privilege('${role}','${signature}','EXECUTE');`), "f");
      assert.equal(sql(`select has_function_privilege('service_role','${signature}','EXECUTE');`), "t");
      assert.ok((await anonymous.rpc("manage_staff", { p_token_hash: "0".repeat(64), p_operation: "set-active", p_staff_id: staffId, p_active: false })).error);
      for (const hash of ["0".repeat(64), digest(staffCookie.split("=")[1])]) {
        const result = await admin.rpc("manage_staff", { p_token_hash: hash, p_operation: "set-active", p_staff_id: staffId, p_active: false });
        assert.equal(result.error?.code, "42501");
      }
      const managerHash = digest(cookies[1].split("=")[1]);
      sql(`update private.app_sessions set expires_at=now()-interval '1 second', created_at=now()-interval '2 hours' where token_hash='${managerHash}';`);
      const expired = await admin.rpc("manage_staff", { p_token_hash: managerHash, p_operation: "set-active", p_staff_id: foreignId, p_active: false });
      assert.equal(expired.error?.code, "42501");
      assert.equal((await change("status", { active: false }, foreignId, cookies[1])).response.status, 401);
    });
    await check("database independently rejects cross-tenant changes, weak hashes and duplicate assignments", async () => {
      const token = digest(cookies[0].split("=")[1]);
      const args = { p_token_hash: token, p_operation: "update", p_staff_id: staffId, p_name: "Forbidden", p_staff_code: code, p_assignments: [foreign] };
      assert.equal((await admin.rpc("manage_staff", args)).error?.code, "42501");
      assert.equal((await admin.rpc("manage_staff", { ...args, p_staff_id: foreignId, p_assignments: [] })).error?.code, "P0002");
      assert.equal((await admin.rpc("manage_staff", { ...args, p_assignments: [assignment, assignment] })).error?.code, "22023");
      assert.equal((await admin.rpc("manage_staff", { p_token_hash: token, p_operation: "reset-pin", p_staff_id: staffId, p_pin_hash: "123456" })).error?.code, "22023");
      assert.equal(staffRow().name, "Updated staff");
    });
    await check("PIN reset racing with login cannot issue a session for the old credential version", async () => {
      const version = digest(staffRow().pin_hash);
      assert.equal((await change("pin", { pin })).response.status, 200);
      const issue = await admin.rpc("issue_app_session", { p_token_hash: digest(randomBytes(32).toString("hex")), p_role: "staff", p_identity_id: staffId, p_credential_version: version });
      assert.ok(issue.error); assert.equal((await session(staffCookie)).response.status, 401);
    });
    await check("manager logout immediately removes staff-management access", async () => {
      assert.equal((await request("/api/auth/logout", { method: "POST", cookie: cookies[0] })).response.status, 200);
      assert.equal((await get()).response.status, 401); assert.equal((await create(profile())).response.status, 401);
    });
    assert.ok(!output.includes(password) && !output.includes("$scrypt$"), "No credentials are logged.");
  } finally {
    if (server) { server.kill(); await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]); }
    clearRates();
    for (const table of ["queue_tickets", "service_daily_counters", "staff_assignments", "services", "staff", "locations", "managers"]) {
      sql(`delete from public.${table} where organization_id in ('${f.org}','${f.otherOrg}');`);
    }
    sql(`delete from public.organizations where id in ('${f.org}','${f.otherOrg}');`);
    for (const id of users) await admin.auth.admin.deleteUser(id);
  }
});
