import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hashPin } from "../lib/auth/pin.ts";
import { estimatedWaitLabel } from "../lib/customer/estimate.ts";

const f = Object.fromEntries(["org", "otherOrg", "loc", "otherLoc", "service", "otherService", "siblingService", "staff", "otherStaff", "token"].map(k => [k, randomUUID()]));
const pinHash = await hashPin("681429");
const fixture = `
  insert into public.organizations(id,name) values ('${f.org}','Estimate test'),('${f.otherOrg}','Other tenant');
  insert into public.locations(id,organization_id,name,slug) values
    ('${f.loc}','${f.org}','Estimate location','eta-${f.loc}'),('${f.otherLoc}','${f.otherOrg}','Other location','eta-${f.otherLoc}');
  insert into public.services(id,organization_id,location_id,name,queue_prefix,default_service_minutes) values
    ('${f.service}','${f.org}','${f.loc}','Main','E',8),('${f.siblingService}','${f.org}','${f.loc}','Sibling','S',20),
    ('${f.otherService}','${f.otherOrg}','${f.otherLoc}','Other','O',99);
  insert into public.staff(id,organization_id,name,staff_code,pin_hash) values
    ('${f.staff}','${f.org}','Private staff','E_${f.staff.replaceAll("-", "").slice(0, 20).toUpperCase()}','${pinHash}'),
    ('${f.otherStaff}','${f.otherOrg}','Other staff','E_${f.otherStaff.replaceAll("-", "").slice(0, 20).toUpperCase()}','${pinHash}');
  insert into public.queue_tickets(organization_id,location_id,service_id,queue_date,queue_sequence,queue_prefix,customer_name,joined_at,ticket_token)
    select '${f.org}','${f.loc}','${f.service}',current_date,n,'E','Private customer',now()-make_interval(mins=>4-n),
      case when n=3 then '${f.token}'::uuid else gen_random_uuid() end from generate_series(1,3) n;
`;
function query(body, select) {
  const output = execFileSync("docker", ["exec", "-i", "supabase_db_digital-queue-management-system", "psql", "-X", "-qAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
    input: `begin; ${fixture} ${body} select (${select})::text; rollback;`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  return output.trim();
}
const estimate = `private.queue_wait_minutes('${f.org}','${f.loc}','${f.service}',2)`;
function history({ count = 5, duration = "360", finish = "now()-interval '1 hour'", service = f.service, org = f.org, loc = f.loc, staff = f.staff, offset = 0 } = {}) {
  return `insert into public.queue_tickets(organization_id,location_id,service_id,queue_date,queue_sequence,queue_prefix,customer_name,status,joined_at,started_at,completed_at,served_by_staff_id)
    select '${org}','${loc}','${service}',current_date-100,n+${offset},'H','Private historical name','COMPLETED',
      (${finish})-make_interval(secs=>(${duration})+60),(${finish})-make_interval(secs=>(${duration})),(${finish}),'${staff}'
      from generate_series(1,${count}) n;`;
}

test("estimate display distinguishes zero from unavailable and rejects unsafe values", () => {
  assert.equal(estimatedWaitLabel(16), "About 16 min"); assert.equal(estimatedWaitLabel(0), "You’re next");
  for (const invalid of [null, undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(estimatedWaitLabel(invalid), null);
});
test("no history and fewer than five samples use configured duration", () => {
  assert.equal(query("", estimate), "16"); assert.equal(query(history({ count: 4 }), estimate), "16");
});
test("five recent samples use their actual historical average; rounding follows multiplication", () => {
  assert.equal(query(history({ duration: "n*120" }), estimate), "12");
  assert.equal(query(history({ duration: "61" }), estimate), "3");
});
test("zero duration, stale, infinite and future history cannot make a reliable sample", () => {
  for (const opts of [{ duration: "0" }, { finish: "now()-interval '31 days'" }, { finish: "now()+interval '1 day'" }, { finish: "'infinity'::timestamptz" }]) {
    assert.equal(query(history(opts), estimate), "16");
  }
});
test("skipped and serving tickets are excluded from the average", () => {
  const samples = history();
  assert.equal(query(`${samples} update public.queue_tickets set status='SKIPPED',skipped_at=completed_at,completed_at=null where status='COMPLETED' and organization_id='${f.org}';`, estimate), "16");
  assert.equal(query(`${history({ count: 1 })} update public.queue_tickets set status='SERVING',completed_at=null where status='COMPLETED' and organization_id='${f.org}';`, estimate), "16");
});
test("history is limited to the most recent 100 valid completed visits", () => {
  assert.equal(query(history({ count: 100, duration: "120" }) + history({ count: 50, duration: "3600", finish: "now()-interval '10 days'", offset: 100 }), estimate), "4");
});
test("other services, locations and organizations never influence an estimate", () => {
  const unrelated = history({ service: f.siblingService, duration: "7200" }) + history({ service: f.otherService, loc: f.otherLoc, org: f.otherOrg, staff: f.otherStaff, duration: "7200" });
  assert.equal(query(unrelated, estimate), "16");
  assert.equal(query("", `private.queue_wait_minutes('${f.otherOrg}','${f.loc}','${f.service}',2) is null`), "true");
  assert.equal(query("", `private.queue_wait_minutes('${f.org}','${f.otherLoc}','${f.service}',2) is null`), "true");
});
test("public ticket and service snapshots expose only their derived estimate", () => {
  const ticket = JSON.parse(query("", `public.get_public_queue_ticket('${f.token}')`));
  assert.equal(ticket.peopleAhead, 2); assert.equal(ticket.estimatedWaitMinutes, 16);
  assert.ok(!JSON.stringify(ticket).includes("Private"));
  const location = JSON.parse(query("", `public.get_public_queue_location('eta-${f.loc}')`));
  const main = location.services.find(s => s.id === f.service);
  assert.equal(main.waitingCount, 3); assert.equal(main.estimatedWaitMinutes, 24);
  assert.equal(query("", `public.get_public_queue_ticket('${randomUUID()}') is null`), "true");
});
test("position changes recalculate ETA and non-waiting tickets have no ETA", () => {
  const called = `update public.queue_tickets set status='SERVING',started_at=now(),served_by_staff_id='${f.staff}' where service_id='${f.service}' and queue_sequence=1;`;
  assert.equal(JSON.parse(query(called, `public.get_public_queue_ticket('${f.token}')`)).estimatedWaitMinutes, 8);
  const skip = `update public.queue_tickets set status='SKIPPED',started_at=now(),skipped_at=now(),served_by_staff_id='${f.staff}' where service_id='${f.service}' and queue_sequence in (1,2);`;
  assert.equal(JSON.parse(query(skip, `public.get_public_queue_ticket('${f.token}')`)).estimatedWaitMinutes, 0);
  for (const state of ["SERVING", "COMPLETED", "SKIPPED"]) {
    const finish = state === "COMPLETED" ? ",completed_at=now()" : state === "SKIPPED" ? ",skipped_at=now()" : "";
    const ticket = JSON.parse(query(`update public.queue_tickets set status='${state}',started_at=now(),served_by_staff_id='${f.staff}'${finish} where ticket_token='${f.token}';`, `public.get_public_queue_ticket('${f.token}')`));
    assert.equal(ticket.estimatedWaitMinutes, null); assert.equal(ticket.peopleAhead, null);
  }
});
test("private duration helper and public read RPCs remain unavailable to browser roles", () => {
  for (const role of ["anon", "authenticated"]) for (const signature of ["private.queue_wait_minutes(uuid,uuid,uuid,bigint)", "public.get_public_queue_ticket(uuid)", "public.get_public_queue_location(text)"]) {
    assert.equal(query("", `has_function_privilege('${role}','${signature}','EXECUTE')`), "false");
  }
  assert.equal(query("", `private.queue_wait_minutes('${f.org}','${f.loc}','${f.service}',-1) is null`), "true");
});
