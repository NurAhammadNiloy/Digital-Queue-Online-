import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { hashPin } from "../lib/auth/pin.ts";
import { canonicalCustomerName, isRandomToken } from "../lib/customer/input.ts";
import { prepareJoinAttempt, retryStorageKey } from "../lib/customer/retry.ts";

const origin = "http://127.0.0.1:3102";
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
function sql(statement) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_digital-queue-management-system", "psql", "-X", "-qAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

test("browser retry keys survive refresh, expire and tolerate unavailable storage", async () => {
  const storage = new Map();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
  } });
  try {
    const slug = "retry-test", service = randomUUID();
    const a = await prepareJoinAttempt(slug, canonicalCustomerName("  Jose\u0301   Smith  "), service);
    assert.ok(isRandomToken(a.key));
    const b = await prepareJoinAttempt(slug, "José Smith", service); assert.equal(a.key, b.key);
    assert.ok(!storage.get(retryStorageKey(slug)).includes("José"));
    const different = await prepareJoinAttempt(slug, "Different person", service); assert.notEqual(a.key, different.key);
    storage.set(retryStorageKey(slug), JSON.stringify({ ...a, createdAt: Date.now() - 86400001 }));
    assert.notEqual((await prepareJoinAttempt(slug, "José Smith", service)).key, a.key);
    storage.set(retryStorageKey(slug), "broken json");
    assert.ok(isRandomToken((await prepareJoinAttempt(slug, "José Smith", service)).key));
    delete globalThis.sessionStorage;
    assert.equal((await prepareJoinAttempt(slug, "José Smith", service, a)).key, a.key);
  } finally { delete globalThis.sessionStorage; }
});

test("public customer flow (real local Supabase and production Next.js)", { timeout: 240000 }, async (t) => {
  assert.ok(process.env.npm_execpath, "Run with npm run test:customer.");
  const status = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "exec", "--yes", "--package=supabase@2.117.0", "--", "supabase", "status", "-o", "json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(new URL(status.API_URL).hostname, "127.0.0.1");
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(status.API_URL, status.PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const f = Object.fromEntries(["org", "otherOrg", "loc", "siblingLoc", "otherLoc", "inactiveLoc", "service", "inactiveService", "siblingService", "otherService", "staff"].map((key) => [key, randomUUID()]));
  const tag = randomBytes(6).toString("hex"), slug = `customer-${tag}`;
  const secret = randomBytes(32).toString("hex"), staffCode = `CUSTOMER_TEST_${tag.toUpperCase()}`;
  const pin = "398247", pinHash = await hashPin(pin);
  const rateKey = (key) => createHmac("sha256", secret).update(key).digest("hex");
  const keys = ["public:join:ip:shared-origin", "public:read:ip:shared-origin", "ip:shared-origin", `staff:account:${staffCode}`].map(rateKey);
  const clearRates = () => sql(`delete from private.auth_rate_limits where key_hash in (${keys.map(literal).join(",")});`);
  const check = async (name, fn) => { clearRates(); await t.test(name, fn); };
  let server, output = "", first, staffCookie;
  async function request(path, { method = "GET", body, cookie, key, csrfOrigin = origin, extraHeaders = {} } = {}) {
    const headers = { ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    if (key) headers["idempotency-key"] = key;
    if (method !== "GET") { headers.origin = csrfOrigin; headers["content-type"] = "application/json"; }
    const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    return { response, data, text, cookie: response.headers.getSetCookie()[0]?.split(";")[0] };
  }
  const create = (body = { name: "Customer", serviceId: f.service }, key = randomUUID(), locationSlug = slug) => request(`/api/public/locations/${locationSlug}/tickets`, { method: "POST", body, key });
  const lookup = (token) => request(`/api/public/tickets/${token}`);
  const row = (token) => JSON.parse(sql(`select row_to_json(t) from public.queue_tickets t where ticket_token=${literal(token)};`));
  const count = () => Number(sql(`select count(*) from public.queue_tickets where organization_id='${f.org}';`));
  const action = (name, body) => request(`/api/staff/queue/${name}`, { method: "POST", body, cookie: staffCookie });
  try {
    sql(`insert into public.organizations(id,name) values ('${f.org}','Customer organization'),('${f.otherOrg}','Foreign organization');
      insert into public.locations(id,organization_id,name,slug,active,timezone) values
        ('${f.loc}','${f.org}','Customer location','${slug}',true,'Europe/Helsinki'),
        ('${f.siblingLoc}','${f.org}','Sibling location','sibling-${tag}',true,'UTC'),
        ('${f.otherLoc}','${f.otherOrg}','Foreign location','foreign-${tag}',true,'UTC'),
        ('${f.inactiveLoc}','${f.org}','Inactive location','inactive-${tag}',false,'UTC');
      insert into public.services(id,organization_id,location_id,name,queue_prefix,default_service_minutes,active) values
        ('${f.service}','${f.org}','${f.loc}','Reception','R',5,true),
        ('${f.inactiveService}','${f.org}','${f.loc}','Inactive service','I',5,false),
        ('${f.siblingService}','${f.org}','${f.siblingLoc}','Sibling service','S',5,true),
        ('${f.otherService}','${f.otherOrg}','${f.otherLoc}','Foreign service','F',5,true);
      insert into public.staff(id,organization_id,name,staff_code,pin_hash) values ('${f.staff}','${f.org}','Private staff','${staffCode}',${literal(pinHash)});
      insert into public.staff_assignments(organization_id,staff_id,location_id,service_id) values ('${f.org}','${f.staff}','${f.loc}','${f.service}');`);
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3102"], {
      env: { ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, AUTH_RATE_LIMIT_SECRET: secret },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { output += chunk; }); server.stderr.on("data", (chunk) => { output += chunk; });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (server.exitCode !== null) throw new Error("Test server failed to start; check port 3102.");
      try { if ((await fetch(origin)).status === 200) { ready = true; break; } } catch {}
      await delay(250);
    }
    assert.ok(ready);

    await check("public location exposes only safe display fields and active services", async () => {
      const result = await request(`/api/public/locations/${slug}`); assert.equal(result.response.status, 200, result.text);
      assert.deepEqual(result.data.location, { name: "Customer location", organizationName: "Customer organization", slug,
        services: [{ id: f.service, name: "Reception", code: "R", waitingCount: 0, estimatedWaitMinutes: 0 }] });
      for (const forbidden of [f.org, f.loc, f.staff, pinHash, "Inactive service", "Foreign", "staff_code"]) assert.ok(!result.text.includes(forbidden));
      const page = await request(`/q/${slug}`); assert.equal(page.response.status, 200); assert.ok(page.text.includes("Join queue"));
      assert.ok(page.text.includes('name="name"')); assert.ok(page.text.includes('name="serviceId"'));
    });
    await check("unknown, malformed and inactive locations return unavailable without enumeration details", async () => {
      for (const value of [`missing-${tag}`, `inactive-${tag}`, "BAD_SLUG"]) {
        const result = await request(`/api/public/locations/${value}`);
        assert.equal(result.response.status, 404); assert.deepEqual(result.data, { error: "Location unavailable." });
        assert.equal((await request(`/q/${value}`)).response.status, 404);
        assert.equal((await create(undefined, randomUUID(), value)).response.status, 404);
      }
    });
    await check("customer joins without an account and receives existing daily numbering plus a random token", async () => {
      const result = await create({ name: "  Jose\u0301   Customer  ", serviceId: f.service });
      assert.equal(result.response.status, 201, result.text); first = result.data;
      assert.equal(result.cookie, undefined); assert.ok(isRandomToken(first.token)); assert.equal(first.statusUrl, `/ticket/${first.token}`);
      assert.equal(first.ticket.queueNumber, "R-001"); assert.equal(first.ticket.status, "WAITING"); assert.equal(first.ticket.peopleAhead, 0);
      assert.equal(first.ticket.service, "Reception"); assert.ok(!Number.isNaN(Date.parse(first.ticket.joinedAt)));
      const created = row(first.token); assert.equal(created.customer_name, "José Customer"); assert.notEqual(created.id, first.token);
      assert.equal(created.organization_id, f.org); assert.equal(created.location_id, f.loc);
      assert.equal(sql(`select queue_date = (joined_at at time zone 'Europe/Helsinki')::date from public.queue_tickets where ticket_token='${first.token}';`), "t");
    });
    await check("foreign-location, foreign-organization and inactive services are rejected with no allocation", async () => {
      const before = count();
      for (const serviceId of [f.siblingService, f.otherService, f.inactiveService, randomUUID()]) assert.equal((await create({ name: "Rejected", serviceId })).response.status, 400);
      assert.equal(count(), before);
      assert.equal(sql(`select last_number from public.service_daily_counters where service_id='${f.service}';`), "1");
    });
    await check("blank, control-character, malformed and oversized names and service IDs are rejected", async () => {
      const before = count();
      for (const name of ["", "   ", "\u00a0\u2003", "Line\nBreak", "Tab\tName", "Null\u0000", "Del\u007f", "Bidi\u202e", "Zero\u200b", "a".repeat(201), 12345, null]) {
        assert.equal((await create({ name, serviceId: f.service })).response.status, 400);
        clearRates();
      }
      for (const serviceId of ["invalid", `${f.service}\n`, null, 1]) assert.equal((await create({ name: "Name", serviceId })).response.status, 400);
      assert.equal((await create({ name: "x".repeat(5000), serviceId: f.service })).response.status, 413);
      assert.equal(count(), before);
    });
    await check("browser-supplied tenant, status, number, timestamps and tokens are rejected", async () => {
      const before = count();
      for (const extra of [{ organizationId: f.otherOrg }, { locationId: f.otherLoc }, { status: "SERVING" }, { queueNumber: "R-999" }, { joinedAt: new Date().toISOString() }, { token: randomUUID() }, { staffId: f.staff }, { name: "Name", serviceId: f.service, role: "manager" }]) {
        assert.equal((await create({ name: "Name", serviceId: f.service, ...extra })).response.status, 400);
      }
      assert.equal((await request(`/api/public/locations/${slug}?organizationId=${f.otherOrg}`)).response.status, 400);
      assert.equal(count(), before);
    });
    await check("valid token returns exactly its safe ticket; random and malformed tokens share one 404", async () => {
      const current = await lookup(first.token); assert.equal(current.response.status, 200);
      assert.deepEqual(Object.keys(current.data.ticket).sort(), ["queueNumber", "service", "location", "locationTimezone", "status", "joinedAt", "calledAt", "completedAt", "skippedAt", "peopleAhead", "estimatedWaitMinutes"].sort());
      for (const token of [randomUUID(), "not-a-token", row(first.token).id, `${first.token.slice(0, 35)}${first.token.endsWith("0") ? "1" : "0"}`]) {
        const result = await lookup(token); assert.equal(result.response.status, 404); assert.deepEqual(result.data, { error: "Ticket not found." });
        assert.equal((await request(`/ticket/${token}`)).response.status, 404);
      }
    });
    await check("ticket reads cannot expose other names, tokens, staff or internal IDs", async () => {
      const other = await create({ name: "Other secret customer", serviceId: f.service }); assert.equal(other.response.status, 201);
      const own = await lookup(first.token);
      for (const forbidden of ["Other secret customer", "José Customer", other.data.token, f.org, f.loc, f.service, f.staff, pinHash, status.SERVICE_ROLE_KEY]) assert.ok(!own.text.includes(forbidden));
      const page = await request(first.statusUrl); assert.equal(page.response.status, 200); assert.ok(page.text.includes("R-001"));
      assert.ok(!page.text.includes(other.data.token)); assert.ok(!page.text.includes("Other secret customer"));
    });
    await check("concurrent double submission and retries yield one ticket and one counter increment", async () => {
      const key = randomUUID(), body = { name: "Double submit", serviceId: f.service }, before = count();
      const results = await Promise.all([create(body, key), create(body, key), create(body, key)]);
      assert.ok(results.every((r) => r.response.status === 201), results.map((r) => r.text).join(" "));
      assert.equal(new Set(results.map((r) => r.data.token)).size, 1); assert.equal(count(), before + 1);
      assert.equal((await create({ name: "  Double   submit  ", serviceId: f.service.toUpperCase() }, key.toUpperCase())).data.token, results[0].data.token);
      assert.equal(sql(`select count(*) from private.customer_join_requests where key_hash='${digest(key)}';`), "1");
      assert.equal((await create({ ...body, name: "Different" }, key)).response.status, 409); assert.equal(count(), before + 1);
      assert.equal((await create({ name: body.name, serviceId: f.siblingService }, key, `sibling-${tag}`)).response.status, 409);
    });
    await check("failed join rolls back retry records; the same key can retry after configuration is enabled", async () => {
      const key = randomUUID(), body = { name: "Retry after reopen", serviceId: f.inactiveService };
      assert.equal((await create(body, key)).response.status, 400);
      assert.equal(sql(`select count(*) from private.customer_join_requests where key_hash='${digest(key)}';`), "0");
      sql(`update public.services set active=true where id='${f.inactiveService}';`);
      try { assert.equal((await create(body, key)).response.status, 201); } finally { sql(`update public.services set active=false where id='${f.inactiveService}';`); }
    });
    await check("replay retrieves the same ticket after closure; new joins are blocked", async () => {
      const key = randomUUID(), body = { name: "Before closure", serviceId: f.service };
      const result = await create(body, key); assert.equal(result.response.status, 201);
      sql(`update public.locations set active=false where id='${f.loc}';`);
      try {
        assert.equal((await create(body, key)).data.token, result.data.token);
        assert.equal((await create(body)).response.status, 404);
        assert.equal((await lookup(result.data.token)).response.status, 200);
      } finally { sql(`update public.locations set active=true where id='${f.loc}';`); }
    });
    await check("people ahead respects waiting state, service/location, previous days and UUID tie-breaking", async () => {
      // Set identical order timestamps to exercise the actual UUID tie-breaker,
      // including previous-day tickets. Other services must not affect the count.
      sql(`update public.queue_tickets set joined_at=now()-interval '1 day' where service_id='${f.service}' and status='WAITING';`);
      const rows = JSON.parse(sql(`select json_agg(t order by joined_at,id) from (select id,ticket_token,joined_at from public.queue_tickets where service_id='${f.service}' and status='WAITING') t;`));
      assert.equal((await request(`/api/public/locations/${slug}`)).data.location.services[0].waitingCount, rows.length);
      for (let i = 0; i < rows.length; i++) assert.equal((await lookup(rows[i].ticket_token)).data.ticket.peopleAhead, i);
      const other = await create({ name: "Separate queue", serviceId: f.siblingService }, randomUUID(), `sibling-${tag}`);
      assert.equal(other.data.ticket.peopleAhead, 0);
      const login = await request("/api/auth/staff/login", { method: "POST", body: { staffCode, pin } }); assert.equal(login.response.status, 200); staffCookie = login.cookie;
      const called = await action("call-next", { serviceId: f.service }); assert.equal(called.response.status, 200, called.text);
      const serving = JSON.parse(sql(`select row_to_json(t) from public.queue_tickets t where served_by_staff_id='${f.staff}' and status='SERVING';`));
      assert.equal(serving.id, rows[0].id);
      const view = (await lookup(serving.ticket_token)).data.ticket; assert.equal(view.status, "SERVING"); assert.equal(view.peopleAhead, null); assert.ok(view.calledAt);
      assert.equal((await request(`/api/public/locations/${slug}`)).data.location.services[0].waitingCount, rows.length - 1);
      assert.equal((await lookup(rows[1].ticket_token)).data.ticket.peopleAhead, 0);
      assert.equal((await action("complete", { ticketId: serving.id })).response.status, 200);
      const completed = (await lookup(serving.ticket_token)).data.ticket; assert.equal(completed.status, "COMPLETED"); assert.ok(completed.completedAt);
      assert.equal((await action("call-next", { serviceId: f.service })).response.status, 200);
      assert.equal((await action("skip", { ticketId: rows[1].id })).response.status, 200);
      const skipped = (await lookup(rows[1].ticket_token)).data.ticket; assert.equal(skipped.status, "SKIPPED"); assert.ok(skipped.skippedAt); assert.equal(skipped.peopleAhead, null);
    });
    await check("repeated status polling and page refresh never create another ticket", async () => {
      const before = count();
      for (let i = 0; i < 5; i++) assert.equal((await lookup(first.token)).response.status, 200);
      assert.equal((await request(first.statusUrl)).response.status, 200); assert.equal(count(), before);
      assert.equal((await request(`/api/public/tickets/${first.token}`, { method: "POST", body: {} })).response.status, 405);
    });
    await check("creation enforces Origin, request keys and strict body limits", async () => {
      const path = `/api/public/locations/${slug}/tickets`, body = { name: "CSRF", serviceId: f.service }, before = count();
      for (const csrfOrigin of ["", "https://attacker.invalid"]) assert.equal((await request(path, { method: "POST", body, key: randomUUID(), csrfOrigin })).response.status, 403);
      assert.equal((await request(path, { method: "POST", body, key: randomUUID(), extraHeaders: { "sec-fetch-site": "cross-site" } })).response.status, 403);
      for (const key of [undefined, "guessable", f.service.replace(/./, "z")]) assert.equal((await request(path, { method: "POST", body, key })).response.status, 400);
      assert.equal((await request(path)).response.status, 405); assert.equal(count(), before);
    });
    await check("creation throttling blocks attempt eleven, shares state and ignores spoofed IP headers", async () => {
      const body = { name: "Throttled retry", serviceId: f.service }, key = randomUUID(), before = count();
      for (let i = 0; i < 10; i++) assert.equal((await create(body, key)).response.status, 201);
      const limited = await request(`/api/public/locations/${slug}/tickets`, { method: "POST", body, key,
        extraHeaders: { "x-forwarded-for": "203.0.113.44", "x-vercel-forwarded-for": "203.0.113.44" } });
      assert.equal(limited.response.status, 429); assert.equal(limited.response.headers.get("retry-after"), "900"); assert.equal(count(), before + 1);
      sql(`update private.auth_rate_limits set resets_at=now()-interval '1 second' where key_hash='${keys[0]}';`);
      assert.equal((await create(body, key)).response.status, 201); assert.equal(count(), before + 1);
    });
    await check("read throttling protects token lookups and cannot be bypassed through server pages", async () => {
      const hash = keys[1];
      sql(`insert into private.auth_rate_limits(key_hash,attempts,resets_at) values ('${hash}',299,now()+interval '1 minute') on conflict (key_hash) do update set attempts=299,resets_at=now()+interval '1 minute';`);
      assert.equal((await lookup(first.token)).response.status, 200);
      const limited = await lookup(randomUUID()); assert.equal(limited.response.status, 429); assert.equal(limited.response.headers.get("retry-after"), "60");
      const page = await request(first.statusUrl); assert.ok(page.text.includes("Status temporarily unavailable")); assert.ok(!page.text.includes('"queueNumber"'));
      assert.equal((await request(`/api/public/locations/${slug}`)).response.status, 429);
    });
    await check("public callers cannot execute privileged RPCs, read retry records or mutate staff/manager state", async () => {
      const signatures = ["public.get_public_queue_location(text)", "public.get_public_queue_ticket(uuid)", "public.join_public_queue(text,uuid,text,text,text)", "public.prune_customer_join_requests()", "public.create_queue_ticket(uuid,uuid,text)", "public.get_queue_ticket_by_token(uuid)", "public.perform_staff_queue_action(text,text,uuid,uuid)", "public.manage_staff(text,text,uuid,text,text,text,jsonb,boolean)"];
      for (const role of ["anon", "authenticated"]) {
        for (const signature of signatures) assert.equal(sql(`select has_function_privilege('${role}','${signature}','EXECUTE');`), "f");
        assert.equal(sql(`select has_table_privilege('${role}','private.customer_join_requests','SELECT');`), "f");
      }
      assert.ok((await anon.rpc("join_public_queue", { p_slug: slug, p_service_id: f.service, p_customer_name: "Attack", p_key_hash: "0".repeat(64), p_payload_hash: "1".repeat(64) })).error);
      assert.ok((await anon.from("queue_tickets").select("ticket_token")).error);
      assert.equal((await request("/api/manager/staff", { method: "POST", body: {} })).response.status, 401);
      assert.equal((await request("/api/staff/queue/call-next", { method: "POST", body: { serviceId: f.service } })).response.status, 401);
    });
    await check("database wrapper independently verifies slug/service relationships and control-free names", async () => {
      for (const [serviceId, name] of [[f.otherService, "Forbidden"], [f.siblingService, "Forbidden"], [f.service, "Invalid\nName"]]) {
        const result = await admin.rpc("join_public_queue", { p_slug: slug, p_service_id: serviceId, p_customer_name: name, p_key_hash: digest(randomUUID()), p_payload_hash: digest(randomUUID()) });
        assert.equal(result.error?.code, "22023");
      }
    });
    await check("public pages, errors and APIs disable caching, indexing, framing and referrer leakage", async () => {
      for (const path of [`/q/${slug}`, first.statusUrl, `/api/public/tickets/${first.token}`, "/api/public/tickets/invalid", `/api/public/locations/${slug}`]) {
        const result = await request(path);
        assert.match(result.response.headers.get("cache-control"), /no-store/);
        assert.equal(result.response.headers.get("referrer-policy"), "no-referrer"); assert.match(result.response.headers.get("x-robots-tag"), /noindex/);
        assert.equal(result.response.headers.get("x-frame-options"), "DENY"); assert.equal(result.response.headers.get("access-control-allow-origin"), null);
      }
      for (const name of readdirSync(".next/static", { recursive: true }).filter((name) => name.endsWith(".js"))) {
        const content = readFileSync(join(".next/static", name), "utf8");
        assert.ok(!content.includes(status.SERVICE_ROLE_KEY) && !content.includes("SUPABASE_SERVICE_ROLE_KEY"));
      }
    });
    await check("expired retry cleanup preserves tickets and recent retry records", async () => {
      const oldKey = randomUUID(), freshKey = randomUUID();
      const old = await create({ name: "Expired request", serviceId: f.service }, oldKey);
      const fresh = await create({ name: "Recent request", serviceId: f.service }, freshKey);
      assert.equal(old.response.status, 201); assert.equal(fresh.response.status, 201);
      sql(`update private.customer_join_requests set created_at=now()-interval '25 hours' where key_hash='${digest(oldKey)}';`);
      assert.equal((await admin.rpc("prune_customer_join_requests")).error, null);
      assert.equal(sql(`select count(*) from private.customer_join_requests where key_hash='${digest(oldKey)}';`), "0");
      assert.equal(sql(`select count(*) from private.customer_join_requests where key_hash='${digest(freshKey)}';`), "1");
      assert.equal((await lookup(old.data.token)).response.status, 200);
    });
    assert.ok(!output.includes(pinHash) && !output.includes(first.token) && !output.includes("José Customer"), "No sensitive request data is logged.");
  } finally {
    if (server) { server.kill(); await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]); }
    clearRates();
    for (const table of ["queue_tickets", "service_daily_counters", "staff_assignments", "services", "staff", "locations", "managers"]) sql(`delete from public.${table} where organization_id in ('${f.org}','${f.otherOrg}');`);
    sql(`delete from public.organizations where id in ('${f.org}','${f.otherOrg}');`);
  }
});
