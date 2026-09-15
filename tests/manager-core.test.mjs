import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import decodeQR from "qr/decode.js";

const origin = "http://127.0.0.1:3106";
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
function sql(statement) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_digital-queue-management-system", "psql", "-X", "-qAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
// Rasterize the actual SVG returned by the HTTP route, then decode its pixels.
// The decoder is part of the same single QR dependency, not another library.
function decodeSvg(svg) {
  const side = Number(svg.match(/viewBox="0 0 (\d+) \d+"/)[1]), scale = 8, width = side * scale;
  assert.ok(svg.includes('fill="#fff"'), "Opaque white quiet zone");
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  const cells = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="1" height="1" \/>/g)];
  assert.ok(cells.length > 100);
  for (const cell of cells) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
    const offset = ((Number(cell[2]) * scale + dy) * width + Number(cell[1]) * scale + dx) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = 0;
  }
  return decodeQR({ width, height: width, data });
}

test("manager core administration — real database, Auth, HTTP and rendered pages", { timeout: 180000 }, async (t) => {
  const cfg = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "exec", "--yes", "--package=supabase@2.117.0", "--", "supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(new URL(cfg.API_URL).hostname, "127.0.0.1", "Local fixtures only");
  const admin = createClient(cfg.API_URL, cfg.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const f = { org: randomUUID(), otherOrg: randomUUID() }, users = [], cookies = [], rateKeys = new Set();
  const tag = randomBytes(6).toString("hex"), secret = randomBytes(32).toString("hex"), password = randomBytes(32).toString("base64url");
  const emails = [`core-${tag}@example.invalid`, `core-foreign-${tag}@example.invalid`];
  const code = `CORE_${tag.toUpperCase()}`, pin = "483927";
  let server, output = "", loc, sibling, foreign, service, foreignService, staffId, staffCookie;
  const locationBody = (extra = {}) => ({ name: "Café Reception", description: "Reception description", address: "1 Test Street", active: true, ...extra });
  const serviceBody = (extra = {}) => ({ name: "Consultation", queuePrefix: "c", defaultServiceMinutes: 7, active: true, ...extra });
  const rateKey = (key) => rateKeys.add(createHmac("sha256", secret).update(key).digest("hex"));
  for (const key of ["ip:shared-origin", "public:join:ip:shared-origin", "public:read:ip:shared-origin", `staff:account:${code}`, ...emails.map((email) => `manager:account:${email}`)]) rateKey(key);
  async function req(path, { method = "GET", body, cookie = cookies[0], csrfOrigin = origin, headers = {} } = {}) {
    if (cookie) headers.cookie = cookie;
    if (method !== "GET") { headers.origin = csrfOrigin; headers["content-type"] = "application/json"; }
    const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = null; }
    return { response, text, data, cookie: response.headers.getSetCookie()[0]?.split(";")[0] };
  }
  const createLocation = (body = locationBody(), cookie = cookies[0]) => req("/api/manager/locations", { method: "POST", body, cookie });
  const updateLocation = (body = locationBody(), id = loc.id) => req(`/api/manager/locations/${id}`, { method: "PUT", body });
  const getLocation = (id) => req(`/api/manager/locations/${id}`);
  const createService = (body = serviceBody(), id = loc.id, cookie = cookies[0]) => req(`/api/manager/locations/${id}/services`, { method: "POST", body, cookie });
  const updateService = (body = serviceBody(), id = service.id, locationId = loc.id) => req(`/api/manager/locations/${locationId}/services/${id}`, { method: "PUT", body });
  const dashboard = () => req(`/api/manager/dashboard${loc ? `?locationId=${loc.id}` : ""}`);
  const join = (name = "Core customer") => req(`/api/public/locations/${loc.slug}/tickets`, { method: "POST", body: { name, serviceId: service.id }, cookie: null, headers: { "idempotency-key": randomUUID() } });
  const staffAction = (action, body) => req(`/api/staff/queue/${action}`, { method: "POST", body, cookie: staffCookie });
  const tokenHash = () => digest(cookies[0].split("=")[1]);
  try {
    for (const email of emails) {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true }); assert.equal(error, null); users.push(data.user.id);
    }
    sql(`insert into public.organizations(id,name) values ('${f.org}','Manager core'),('${f.otherOrg}','Foreign manager core');
      insert into public.managers(user_id,organization_id,name) values ('${users[0]}','${f.org}','Core manager'),('${users[1]}','${f.otherOrg}','Foreign manager');`);
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3106"], {
      env: { ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, NEXT_PUBLIC_SUPABASE_URL: cfg.API_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: cfg.PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY, AUTH_RATE_LIMIT_SECRET: secret }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => { output += chunk; }); server.stderr.on("data", (chunk) => { output += chunk; });
    let ready = false;
    for (let i = 0; i < 80; i++) { if (server.exitCode !== null) throw new Error("Test server failed; check port 3106."); try { if ((await fetch(origin)).status === 200) { ready = true; break; } } catch {} await delay(250); }
    assert.ok(ready);
    for (const email of emails) { const result = await req("/api/auth/manager/login", { method: "POST", body: { email, password }, cookie: null }); assert.equal(result.response.status, 200); cookies.push(result.cookie); }

    await t.test("all new manager APIs and pages reject unauthenticated requests", async () => {
      const id = randomUUID();
      for (const [path, method] of [["/api/manager/dashboard", "GET"], ["/api/manager/locations", "POST"], [`/api/manager/locations/${id}`, "GET"], [`/api/manager/locations/${id}`, "PUT"], [`/api/manager/locations/${id}/services`, "POST"], [`/api/manager/locations/${id}/services/${id}`, "PUT"], [`/api/manager/locations/${id}/qr`, "GET"]]) {
        assert.equal((await req(path, { method, body: method === "GET" ? undefined : {}, cookie: null })).response.status, 401);
      }
      for (const path of ["/manager", "/manager/locations", `/manager/locations/${id}`, "/manager/staff"]) {
        const r = await req(path, { cookie: null }); assert.equal(r.response.status, 307); assert.equal(new URL(r.response.headers.get("location"), origin).pathname, "/manager/login");
      }
    });
    await t.test("empty organization requires location setup without aggregating counts", async () => {
      const r = await dashboard(); assert.equal(r.response.status, 400); assert.match(r.data.error, /Select a location/); assert.ok((await req("/manager")).text.includes("No locations configured"));
    });
    await t.test("manager creates location in session organization with safe global unique slug", async () => {
      const r = await createLocation(); assert.equal(r.response.status, 201, r.text);
      loc = (await getLocation(r.data.id)).data.location;
      assert.match(loc.slug, /^cafe-reception-[0-9a-f]{16}$/); assert.equal(loc.timezone, "UTC");
      assert.equal(sql(`select organization_id from public.locations where id='${loc.id}';`), f.org);
      const second = await createLocation(); assert.equal(second.response.status, 201); sibling = (await getLocation(second.data.id)).data.location;
      const third = await createLocation(locationBody(), cookies[1]); assert.equal(third.response.status, 201);
      foreign = (await req(`/api/manager/locations/${third.data.id}`, { cookie: cookies[1] })).data.location;
      assert.equal(new Set([loc.slug, sibling.slug, foreign.slug]).size, 3);
      assert.deepEqual(Object.keys((await dashboard()).data).sort(), ["currentlyServing", "servedToday", "waitingNow"]);
    });
    await t.test("manager list and details expose only own location data", async () => {
      const r = await req("/api/manager/locations"); assert.deepEqual(new Set(r.data.locations.map((l) => l.id)), new Set([loc.id, sibling.id]));
      assert.equal((await getLocation(foreign.id)).response.status, 404);
      assert.equal((await req(`/manager/locations/${foreign.id}`)).response.status, 404);
    });
    await t.test("location update preserves URL and timezone, handles optional fields", async () => {
      sql(`update public.locations set timezone='Pacific/Kiritimati' where id='${loc.id}';`);
      const r = await updateLocation(locationBody({ name: "Renamed reception", description: "", address: null })); assert.equal(r.response.status, 200, r.text);
      const current = (await getLocation(loc.id)).data.location;
      assert.equal(current.name, "Renamed reception"); assert.equal(current.slug, loc.slug); assert.equal(current.timezone, "Pacific/Kiritimati"); assert.equal(current.address, null); assert.equal(current.description, null);
    });
    await t.test("location writes reject foreign targets, browser tenant overrides and invalid fields", async () => {
      assert.equal((await updateLocation(locationBody(), foreign.id)).response.status, 404);
      for (const extra of [{ organizationId: f.otherOrg }, { slug: foreign.slug }, { timezone: "Not/A_Zone" }, { name: " " }, { name: "x".repeat(201) }, { active: "true" }, { description: "x".repeat(2001) }, { address: "x".repeat(501) }]) assert.equal((await createLocation(locationBody(extra))).response.status, 400);
      assert.equal((await req("/api/manager/locations", { method: "POST", body: locationBody(), csrfOrigin: "https://foreign.invalid" })).response.status, 403);
      assert.equal((await req(`/api/manager/locations/${loc.id}?organizationId=${f.otherOrg}`)).response.status, 400);
    });
    await t.test("concurrent location edits serialize without lock-upgrade deadlocks", async () => {
      const results = await Promise.all([updateLocation(locationBody({ name: "Concurrent one" })), updateLocation(locationBody({ name: "Concurrent two" }))]);
      assert.deepEqual(results.map((r) => r.response.status), [200, 200]);
    });
    await t.test("service creation normalizes prefix and uses parent organization", async () => {
      const r = await createService(serviceBody({ queuePrefix: " ab " })); assert.equal(r.response.status, 201, r.text);
      service = (await getLocation(loc.id)).data.services.find((s) => s.id === r.data.id);
      assert.equal(service.queue_prefix, "AB"); assert.equal(service.default_service_minutes, 7);
      assert.equal(sql(`select organization_id from public.services where id='${service.id}';`), f.org);
      const other = await createService(serviceBody(), foreign.id, cookies[1]); assert.equal(other.response.status, 201); foreignService = other.data.id;
    });
    await t.test("service uniqueness conflicts are clean and updates remain atomic", async () => {
      for (const body of [serviceBody({ name: " consultation ", queuePrefix: "Z" }), serviceBody({ name: "Other", queuePrefix: "AB" })]) {
        const r = await createService(body); assert.equal(r.response.status, 409); assert.deepEqual(r.data, { error: "Service name or queue prefix already exists at this location." });
      }
      const second = await createService(serviceBody({ name: "Other", queuePrefix: "X" })); assert.equal(second.response.status, 201);
      assert.equal((await updateService(serviceBody({ name: "Changed", queuePrefix: "X" }))).response.status, 409);
      assert.equal((await getLocation(loc.id)).data.services.find((s) => s.id === service.id).name, "Consultation");
    });
    await t.test("service targets and fields cannot bypass tenant or parent checks", async () => {
      assert.equal((await createService(serviceBody(), foreign.id)).response.status, 404);
      assert.equal((await updateService(serviceBody(), foreignService, foreign.id)).response.status, 404);
      assert.equal((await updateService(serviceBody(), foreignService)).response.status, 404);
      assert.equal((await updateService(serviceBody(), service.id, sibling.id)).response.status, 404);
      for (const extra of [{ organizationId: f.otherOrg }, { locationId: foreign.id }, { queuePrefix: "ABCDE" }, { queuePrefix: "A1" }, { defaultServiceMinutes: 0 }, { defaultServiceMinutes: 1.5 }, { defaultServiceMinutes: 2147483648 }, { defaultServiceMinutes: "5" }, { active: null }]) assert.equal((await createService(serviceBody(extra))).response.status, 400);
    });
    await t.test("minimal manager pages render navigation, configuration forms, QR and existing staff tools", async () => {
      for (const [path, labels] of [["/manager", ["Dashboard", "Location", "Waiting now", "Currently serving", "Served today", "Log out"]], ["/manager/locations", ["Create location", "Description", "Address (optional)"]], [`/manager/locations/${loc.id}`, ["Create service", "Edit service", "Default service minutes", "Download QR", "Print QR", `${origin}/q/${loc.slug}`]], ["/manager/staff", ["Staff", "Create staff"]]]) {
        const r = await req(path); assert.equal(r.response.status, 200, path); for (const label of labels) assert.ok(r.text.includes(label), `${path}: ${label}`);
        assert.match(r.response.headers.get("cache-control"), /no-store/); assert.ok(!r.text.includes(cfg.SERVICE_ROLE_KEY));
      }
    });
    await t.test("downloaded and inline QR images decode to the exact configured public URL", async () => {
      for (const suffix of ["", "?download=1"]) {
        const r = await req(`/api/manager/locations/${loc.id}/qr${suffix}`, { headers: { "x-forwarded-host": "attacker.invalid" } });
        assert.equal(r.response.status, 200, r.text); assert.match(r.response.headers.get("content-type"), /image\/svg\+xml/);
        assert.match(r.response.headers.get("cache-control"), /no-store/);
        assert.match(r.response.headers.get("content-disposition"), suffix ? /^attachment/ : /^inline/);
        assert.equal(decodeSvg(r.text), `${origin}/q/${loc.slug}`);
      }
      assert.equal((await req(`/q/${loc.slug}`, { cookie: null })).response.status, 200);
      assert.equal((await req(`/api/manager/locations/${foreign.id}/qr`)).response.status, 404);
      assert.equal((await req(`/api/manager/locations/${loc.id}/qr?url=https://attacker.invalid`)).response.status, 400);
    });
    await t.test("existing staff provisioning assigns a newly managed service without exposing PIN hashes", async () => {
      const r = await req("/api/manager/staff", { method: "POST", body: { name: "Core staff", staffCode: code, pin, assignments: [{ locationId: loc.id, serviceId: service.id }] } });
      assert.equal(r.response.status, 201, r.text); staffId = r.data.id;
      const staff = await req(`/api/manager/staff/${staffId}`); assert.ok(!staff.text.includes("pin_hash")); assert.equal(staff.data.staff.assignments[0].serviceId, service.id);
      const login = await req("/api/auth/staff/login", { method: "POST", cookie: null, body: { staffCode: code, pin } }); assert.equal(login.response.status, 200); staffCookie = login.cookie;
    });
    await t.test("staff role cannot use new manager endpoints or pages", async () => {
      for (const [path, method] of [["/api/manager/dashboard", "GET"], ["/api/manager/locations", "POST"], [`/api/manager/locations/${loc.id}`, "PUT"], [`/api/manager/locations/${loc.id}/services`, "POST"], [`/api/manager/locations/${loc.id}/services/${service.id}`, "PUT"], [`/api/manager/locations/${loc.id}/qr`, "GET"]]) assert.equal((await req(path, { method, cookie: staffCookie, body: method === "GET" ? undefined : {} })).response.status, 403);
      assert.equal((await req("/manager", { cookie: staffCookie })).response.status, 307);
    });
    await t.test("service edits immediately affect public options and new tickets", async () => {
      assert.equal((await updateService(serviceBody({ name: "Updated consultation", queuePrefix: "UP", defaultServiceMinutes: 12 }))).response.status, 200);
      const r = await join(); assert.equal(r.response.status, 201, r.text); assert.equal(r.data.ticket.queueNumber, "UP-001");
      assert.equal((await dashboard()).data.waitingNow, 1);
    });
    await t.test("service deactivation immediately blocks joins and existing staff session operations", async () => {
      assert.equal((await updateService(serviceBody({ active: false }))).response.status, 200);
      const publicData = await req(`/api/public/locations/${loc.slug}`, { cookie: null }); assert.ok(!publicData.data.location.services.some((s) => s.id === service.id));
      assert.notEqual((await join()).response.status, 201);
      assert.equal((await staffAction("call-next", { serviceId: service.id })).response.status, 403);
      const state = await req(`/api/staff/queue?serviceId=${service.id}`, { cookie: staffCookie }); assert.equal(state.response.status, 403);
      assert.equal((await updateService(serviceBody())).response.status, 200);
    });
    await t.test("location deactivation blocks public page and staff actions without deleting tickets", async () => {
      assert.equal((await updateLocation(locationBody({ active: false }))).response.status, 200);
      assert.equal((await req(`/q/${loc.slug}`, { cookie: null })).response.status, 404);
      assert.notEqual((await join()).response.status, 201);
      assert.equal((await staffAction("call-next", { serviceId: service.id })).response.status, 403);
      assert.equal((await dashboard()).data.waitingNow, 1); assert.deepEqual(Object.keys((await dashboard()).data).sort(), ["currentlyServing", "servedToday", "waitingNow"]);
      assert.equal((await updateLocation(locationBody())).response.status, 200);
    });
    await t.test("existing staff/customer lifecycle works after reactivation; dashboard tracks current states", async () => {
      const called = await staffAction("call-next", { serviceId: service.id }); assert.equal(called.response.status, 200, called.text);
      assert.equal(called.data.ticket.queue_number ?? called.data.ticket.queueNumber, "UP-001");
      assert.deepEqual((await dashboard()).data, { waitingNow: 0, currentlyServing: 1, servedToday: 0 });
      assert.equal((await staffAction("complete", { ticketId: called.data.ticket.id })).response.status, 200);
      assert.equal((await dashboard()).data.servedToday, 1);
      assert.equal((await join("Skipped core customer")).response.status, 201);
      const next = await staffAction("call-next", { serviceId: service.id }); assert.equal(next.response.status, 200);
      assert.equal((await staffAction("skip", { ticketId: next.data.ticket.id })).response.status, 200);
      assert.deepEqual((await dashboard()).data, { waitingNow: 0, currentlyServing: 0, servedToday: 1 });
    });
    await t.test("served today uses location-local completion date, excludes yesterday and other organizations", async () => {
      // One completion immediately before local midnight and one exactly at it;
      // both were joined on a prior queue date. No timing-dependent JS date math.
      sql(`with boundary as (select date_trunc('day',now() at time zone timezone) at time zone timezone as start from public.locations where id='${loc.id}')
        insert into public.queue_tickets(organization_id,location_id,service_id,queue_date,queue_sequence,queue_prefix,customer_name,status,joined_at,started_at,completed_at,served_by_staff_id)
        select '${f.org}','${loc.id}','${service.id}',current_date-10,n,'T','Time boundary','COMPLETED',start-interval '2 days',start-interval '1 day',start+case when n=90 then interval '-1 second' else interval '0 seconds' end,'${staffId}' from boundary cross join (values(90),(91)) as seq(n);
        insert into public.queue_tickets(organization_id,location_id,service_id,queue_date,queue_sequence,queue_prefix,customer_name)
        values('${f.otherOrg}','${foreign.id}','${foreignService}',current_date,99,'F','Foreign waiting');`);
      assert.deepEqual((await dashboard()).data, { waitingNow: 0, currentlyServing: 0, servedToday: 2 });
      assert.equal((await req(`/api/manager/dashboard?locationId=${foreign.id}`, { cookie: cookies[1] })).data.waitingNow, 1);
    });
    await t.test("database functions reject direct browser execution and forged targets independently", async () => {
      for (const role of ["anon", "authenticated"]) {
        assert.equal(sql(`select has_function_privilege('${role}','public.get_manager_dashboard(text,uuid)','EXECUTE') or has_function_privilege('${role}','public.manage_location_config(text,text,uuid,uuid,jsonb)','EXECUTE') or has_function_privilege('${role}','private.require_manager_organization(text)','EXECUTE');`), "f");
      }
      const anon = createClient(cfg.API_URL, cfg.PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      assert.ok((await anon.rpc("get_manager_dashboard", { p_token_hash: tokenHash(), p_location_id: loc.id })).error);
      for (const args of [
        { p_operation: "update-location", p_location_id: foreign.id, p_values: locationBody() },
        { p_operation: "update-service", p_location_id: loc.id, p_service_id: foreignService, p_values: serviceBody() },
        { p_operation: "create-location", p_values: { ...locationBody(), slug: `forged-${tag}`, organizationId: f.otherOrg } },
      ]) assert.ok((await admin.rpc("manage_location_config", { p_token_hash: tokenHash(), ...args })).error);
      assert.ok((await admin.rpc("get_manager_dashboard", { p_token_hash: "0".repeat(64), p_location_id: loc.id })).error);
    });
    await t.test("logout invalidates all new manager access even when old cookie is replayed", async () => {
      assert.equal((await req("/api/auth/logout", { method: "POST", body: {} })).response.status, 200);
      assert.equal((await dashboard()).response.status, 401);
      assert.equal((await createLocation()).response.status, 401);
      assert.equal((await req(`/api/manager/locations/${loc.id}/qr`)).response.status, 401);
      assert.equal((await req("/manager/locations")).response.status, 307);
      assert.ok((await admin.rpc("manage_location_config", { p_token_hash: tokenHash(), p_operation: "update-location", p_location_id: loc.id, p_values: locationBody() })).error);
    });
    assert.ok(!output.includes(password) && !output.includes(cfg.SERVICE_ROLE_KEY), "Credentials not logged");
  } finally {
    if (server) { server.kill(); await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]); }
    if (rateKeys.size) sql(`delete from private.auth_rate_limits where key_hash in (${[...rateKeys].map(literal).join(",")});`);
    for (const table of ["queue_tickets", "service_daily_counters", "staff_assignments", "services", "staff", "locations", "managers"]) sql(`delete from public.${table} where organization_id in ('${f.org}','${f.otherOrg}');`);
    sql(`delete from public.organizations where id in ('${f.org}','${f.otherOrg}');`);
    for (const id of users) { const { error } = await admin.auth.admin.deleteUser(id); assert.equal(error, null); }
  }
});
