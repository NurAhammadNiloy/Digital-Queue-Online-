"""Integration tests against the project's LOCAL Supabase PostgreSQL container.

Python standard library + Docker only. No hosted credentials or Python packages.
Uses isolated UUID fixtures and removes only those fixtures in finally.
"""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import subprocess
import uuid


CONTAINER = "supabase_db_digital-queue-management-system"
PASSED = 0


def sql(statement, role=None, user=None, error=None):
    prefix = "begin;\n"
    if role:
        assert role in ("anon", "authenticated", "service_role")
        prefix += f"set local role {role};\n"
    if user:
        prefix += f"set local request.jwt.claim.sub = '{uuid.UUID(user)}';\n"
    result = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-X", "-qAt",
         "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1",
         "-v", "VERBOSITY=verbose"],
        input=prefix + statement + "\ncommit;\n", text=True,
        capture_output=True, timeout=45, encoding="utf-8",
    )
    if error:
        assert result.returncode != 0 and re.search(
            rf"ERROR:\s+{error}:", result.stderr
        ), f"Expected SQLSTATE {error}: {result.stderr} {result.stdout}"
        return None
    assert result.returncode == 0, result.stderr
    return [line for line in result.stdout.splitlines() if line.strip()]


def check(name, condition=True):
    global PASSED
    assert condition, name
    PASSED += 1
    print(f"PASS {name}", flush=True)


def rejected(name, statement, code, role=None, user=None):
    sql(statement, role, user, error=code)
    check(name)


def run():
    org, other_org, loc, other_loc, sibling_loc = [str(uuid.uuid4()) for _ in range(5)]
    service, other_service, single_service, reset_service = [str(uuid.uuid4()) for _ in range(4)]
    staff, staff2, other_staff, unassigned = [str(uuid.uuid4()) for _ in range(4)]
    manager, other_manager = [str(uuid.uuid4()) for _ in range(2)]
    tag = uuid.uuid4().hex[:12]
    # Intentionally invalid encoded test hashes, never usable login credentials.
    fake_hash = "$argon2id$TEST_ONLY_NOT_A_VALID_HASH" + "x" * 64

    def create(svc=service, location=loc, hold=False):
        rows = sql(
            f"select row_to_json(t) from public.create_queue_ticket('{location}', '{svc}', 'Test customer') t;"
            + ("select pg_sleep(0.1);" if hold else ""), "service_role"
        )
        return json.loads(rows[0])

    def call(employee, svc=service, hold=False):
        rows = sql(
            f"select row_to_json(t) from public.call_next_ticket('{svc}', '{employee}') t;"
            + ("select pg_sleep(0.3);" if hold else ""), "service_role"
        )
        return json.loads(rows[0]) if rows else None

    def finish(ticket, employee, operation="complete_queue_ticket"):
        return json.loads(sql(
            f"select row_to_json(t) from public.{operation}('{ticket['id']}', '{employee}') t;",
            "service_role",
        )[0])

    try:
        sql(f"""
          insert into public.organizations(id,name) values ('{org}','Test A'), ('{other_org}','Test B');
          insert into auth.users(id,email) values ('{manager}','test-{tag}@example.invalid'),
            ('{other_manager}','test-other-{tag}@example.invalid');
          insert into public.managers(user_id,organization_id,name) values
            ('{manager}','{org}','Manager A'), ('{other_manager}','{other_org}','Manager B');
          insert into public.locations(id,organization_id,name,slug,timezone) values
            ('{loc}','{org}','Test','test-{tag}','Pacific/Kiritimati'),
            ('{other_loc}','{other_org}','Test','other-{tag}','UTC'),
            ('{sibling_loc}','{org}','Test','sibling-{tag}','UTC');
          insert into public.services(id,organization_id,location_id,name,queue_prefix,default_service_minutes) values
            ('{service}','{org}','{loc}','Test service','T',5),
            ('{other_service}','{other_org}','{other_loc}','Test service','T',5),
            ('{single_service}','{org}','{loc}','Single','S',5),
            ('{reset_service}','{org}','{loc}','Reset','R',5);
          insert into public.staff(id,organization_id,name,staff_code,pin_hash) values
            ('{staff}','{org}','Staff 1','A{tag.upper()}','{fake_hash}'),
            ('{staff2}','{org}','Staff 2','B{tag.upper()}','{fake_hash}'),
            ('{other_staff}','{other_org}','Staff B','C{tag.upper()}','{fake_hash}'),
            ('{unassigned}','{org}','Unassigned','U{tag.upper()}','{fake_hash}');
          insert into public.staff_assignments(organization_id,staff_id,location_id,service_id) values
            ('{org}','{staff}','{loc}','{service}'), ('{org}','{staff2}','{loc}','{service}'),
            ('{org}','{staff}','{loc}','{single_service}'), ('{org}','{staff2}','{loc}','{single_service}'),
            ('{other_org}','{other_staff}','{other_loc}','{other_service}');
        """)

        check("RLS enabled on all eight tables", sql("""
          select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relname in ('organizations','managers','locations',
            'services','staff','staff_assignments','queue_tickets','service_daily_counters') and c.relrowsecurity;
        """)[0] == "8")
        check("definer functions use an empty search_path", sql("""
          select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where ((n.nspname='public' and p.proname in ('create_queue_ticket','call_next_ticket',
            'complete_queue_ticket','skip_queue_ticket','get_queue_ticket_by_token')) or
            (n.nspname='private' and p.proname='manager_organization_id'))
            and p.prosecdef and p.proconfig @> array['search_path=""'];
        """)[0] == "6")

        for label, statement, code in [
            ("cross-organization service rejected", f"insert into public.services(organization_id,location_id,name,queue_prefix,default_service_minutes) values ('{other_org}','{loc}','Bad','BAD',1);", "23503"),
            ("cross-organization assignment rejected", f"insert into public.staff_assignments(organization_id,staff_id,location_id,service_id) values ('{org}','{other_staff}','{loc}','{service}');", "23503"),
            ("wrong-location assignment rejected", f"insert into public.staff_assignments(organization_id,staff_id,location_id,service_id) values ('{org}','{unassigned}','{sibling_loc}','{service}');", "23503"),
            ("duplicate assignment rejected", f"insert into public.staff_assignments(organization_id,staff_id,location_id,service_id) values ('{org}','{staff}','{loc}','{service}');", "23505"),
            ("zero default duration rejected", f"update public.services set default_service_minutes=0 where id='{service}';", "23514"),
            ("invalid prefix rejected", f"update public.services set queue_prefix='too-long' where id='{service}';", "23514"),
            ("duplicate normalized service name rejected", f"insert into public.services(organization_id,location_id,name,queue_prefix,default_service_minutes) values ('{org}','{loc}',' TEST SERVICE ','NEW',1);", "23505"),
            ("duplicate prefix rejected", f"insert into public.services(organization_id,location_id,name,queue_prefix,default_service_minutes) values ('{org}','{loc}','New service','T',1);", "23505"),
            ("global slug uniqueness enforced", f"update public.locations set slug='test-{tag}' where id='{other_loc}';", "23505"),
            ("global staff code uniqueness enforced", f"update public.staff set staff_code='A{tag.upper()}' where id='{other_staff}';", "23505"),
            ("plaintext PIN rejected", f"update public.staff set pin_hash='1234' where id='{staff}';", "23514"),
            ("invalid timezone rejected", f"update public.locations set timezone='Invalid/Zone' where id='{loc}';", "22023"),
            ("manager cannot have a second organization", f"insert into public.managers(user_id,organization_id,name) values ('{manager}','{other_org}','Duplicate');", "23505"),
            ("manager must reference Auth user", f"insert into public.managers(user_id,organization_id,name) values ('{uuid.uuid4()}','{org}','Missing');", "23503"),
        ]:
            rejected(label, statement, code)

        check("public can read active configuration", sql(f"select count(*) from public.locations where id='{loc}';", "anon")[0] == "1")
        sql(f"update public.locations set active=false where id='{loc}';")
        check("public cannot read inactive location/services", sql(f"select count(*) from public.services where location_id='{loc}';", "anon")[0] == "0")
        rejected("inactive location cannot accept tickets", f"select public.create_queue_ticket('{loc}','{service}','Test');", "22023", "service_role")
        sql(f"update public.locations set active=true where id='{loc}'; update public.services set active=false where id='{service}';")
        rejected("inactive service cannot accept tickets", f"select public.create_queue_ticket('{loc}','{service}','Test');", "22023", "service_role")
        sql(f"update public.services set active=true where id='{service}';")
        rejected("blank customer name rejected", f"select public.create_queue_ticket('{loc}','{service}','   ');", "22023", "service_role")
        rejected("whitespace-only customer name rejected", f"select public.create_queue_ticket('{loc}','{service}',E'\\t\\n');", "22023", "service_role")
        rejected("wrong location/service RPC rejected", f"select public.create_queue_ticket('{other_loc}','{service}','Test');", "22023", "service_role")

        for role, user in [("anon", None), ("authenticated", manager)]:
            for fn, args in [
                ("create_queue_ticket", f"'{loc}','{service}','Test'"),
                ("call_next_ticket", f"'{service}','{staff}'"),
                ("complete_queue_ticket", f"'{uuid.uuid4()}','{staff}'"),
                ("skip_queue_ticket", f"'{uuid.uuid4()}','{staff}'"),
                ("get_queue_ticket_by_token", f"'{uuid.uuid4()}'"),
            ]:
                rejected(f"{role} cannot execute {fn}", f"select public.{fn}({args});", "42501", role, user)
            rejected(f"{role} cannot read PIN hashes", "select pin_hash from public.staff;", "42501", role, user)
            rejected(f"{role} cannot read counters", "select * from public.service_daily_counters;", "42501", role, user)
            rejected(f"{role} cannot insert queue tickets", "insert into public.queue_tickets default values;", "42501", role, user)
            rejected(f"{role} cannot update queue tickets", "update public.queue_tickets set status='SKIPPED';", "42501", role, user)
            rejected(f"{role} cannot delete queue tickets", "delete from public.queue_tickets;", "42501", role, user)
        rejected("public cannot enumerate tickets", "select * from public.queue_tickets;", "42501", "anon")
        rejected("service role cannot bypass counter allocation with table insert", "insert into public.queue_tickets default values;", "42501", "service_role")
        rejected("manager cannot self-provision membership", f"insert into public.managers(user_id,organization_id,name) values ('{uuid.uuid4()}','{org}','Bad');", "42501", "authenticated", manager)

        for table in ["organizations", "managers", "locations", "services", "staff", "staff_assignments"]:
            scope_column = "id" if table == "organizations" else "organization_id"
            check(f"manager cannot read other organization {table}", sql(
                f"select count(id) from public.{table} where {scope_column}='{other_org}';", "authenticated", manager
            )[0] == "0")
        check("manager can read own staff metadata", sql(f"select count(id) from public.staff where organization_id='{org}';", "authenticated", manager)[0] == "3")
        for table, row_id in [("locations", other_loc), ("services", other_service), ("staff", other_staff)]:
            check(f"manager cannot update foreign {table}", not sql(f"update public.{table} set name='Forbidden' where id='{row_id}' returning id;", "authenticated", manager))
            check(f"manager cannot delete foreign {table}", not sql(f"delete from public.{table} where id='{row_id}' returning id;", "authenticated", manager))
        rejected("manager cannot move own location into another tenant", f"update public.locations set organization_id='{other_org}' where id='{sibling_loc}';", "42501", "authenticated", manager)
        rejected("manager cannot insert another tenant location", f"insert into public.locations(organization_id,name,slug) values ('{other_org}','Bad','bad-{tag}');", "42501", "authenticated", manager)
        sql(f"insert into public.locations(organization_id,name,slug) values ('{org}','Managed','managed-{tag}'); update public.locations set name='Updated' where slug='managed-{tag}'; delete from public.locations where slug='managed-{tag}';", "authenticated", manager)
        check("manager can create/update/delete own location")

        with ThreadPoolExecutor(max_workers=12) as pool:
            tickets = list(pool.map(lambda _: create(hold=True), range(24)))
        numbers = sorted(t["queue_sequence"] for t in tickets)
        check("24 concurrent creations yield exactly 1..24", numbers == list(range(1, 25)))
        check("all concurrent tokens are unique UUID v4", len({t["ticket_token"] for t in tickets}) == 24 and all(uuid.UUID(t["ticket_token"]).version == 4 for t in tickets))
        check("display number is padded", next(t for t in tickets if t["queue_sequence"] == 1)["queue_number"] == "T-001")
        check("queue day uses location timezone", tickets[0]["queue_date"] == sql("select (clock_timestamp() at time zone 'Pacific/Kiritimati')::date;")[0])
        ticket = tickets[0]
        check("token lookup returns only the exact ticket", json.loads(sql(f"select row_to_json(t) from public.get_queue_ticket_by_token('{ticket['ticket_token']}') t;", "service_role")[0])["ticket_token"] == ticket["ticket_token"])
        check("unknown token returns empty", not sql(f"select * from public.get_queue_ticket_by_token('{uuid.uuid4()}');", "service_role"))
        other_ticket = create(other_service, other_loc)
        check("different service starts at 1", other_ticket["queue_sequence"] == 1)
        check("manager sees own tickets only", sql(f"select count(*) from public.queue_tickets where organization_id='{other_org}';", "authenticated", manager)[0] == "0" and sql(f"select count(*) from public.queue_tickets where organization_id='{org}';", "authenticated", manager)[0] == "24")

        rejected("failed transaction rolls back allocated ticket", f"select public.create_queue_ticket('{loc}','{service}','Rollback'); select 1/0;", "22012", "service_role")
        check("counter increment rolls back with ticket", create()["queue_sequence"] == 25)
        sql(f"insert into public.service_daily_counters values ('{org}','{loc}','{reset_service}',(clock_timestamp() at time zone 'Pacific/Kiritimati')::date-1,999);")
        check("new calendar-day counter starts at 1", create(reset_service)["queue_sequence"] == 1)
        sql(f"update public.service_daily_counters set last_number=999 where service_id='{reset_service}' and queue_date=(clock_timestamp() at time zone 'Pacific/Kiritimati')::date;")
        check("numbers above 999 are not truncated", create(reset_service)["queue_number"] == "R-1000")

        for name, change, code in [
            ("unknown status", "status='INVALID'", "23514"),
            ("serving without attribution", "status='SERVING',started_at=clock_timestamp()", "23514"),
            ("completed without timestamps", "status='COMPLETED'", "23514"),
            ("wrong ticket location", f"location_id='{sibling_loc}'", "23503"),
            ("wrong organization staff attribution", f"status='SERVING',started_at=clock_timestamp(),served_by_staff_id='{other_staff}'", "23503"),
            ("start before join", f"status='SERVING',started_at=joined_at-interval '1 second',served_by_staff_id='{staff}'", "23514"),
            ("completion before start", f"status='COMPLETED',started_at=joined_at,completed_at=joined_at-interval '1 second',served_by_staff_id='{staff}'", "23514"),
        ]:
            rejected(name, f"update public.queue_tickets set {change} where id='{ticket['id']}';", code)

        rejected("unassigned staff cannot call next", f"select public.call_next_ticket('{service}','{unassigned}');", "42501", "service_role")
        rejected("cross-tenant staff cannot call next", f"select public.call_next_ticket('{service}','{other_staff}');", "42501", "service_role")
        sql(f"update public.staff set active=false where id='{staff}';")
        rejected("inactive staff cannot call next", f"select public.call_next_ticket('{service}','{staff}');", "42501", "service_role")
        sql(f"update public.staff set active=true where id='{staff}';")
        oldest = sql(f"select id from public.queue_tickets where service_id='{service}' order by joined_at,id limit 2;")
        with ThreadPoolExecutor(max_workers=2) as pool:
            claimed = list(pool.map(lambda employee: call(employee, hold=True), [staff, staff2]))
        check("two simultaneous calls claim distinct oldest tickets", {t["id"] for t in claimed} == set(oldest))
        check("call records status, staff, and start time", all(t["status"] == "SERVING" and t["started_at"] and t["served_by_staff_id"] for t in claimed))
        for fn in ["complete_queue_ticket", "skip_queue_ticket"]:
            rejected(f"{fn} rejects another staff member", f"select public.{fn}('{claimed[0]['id']}','{staff2}');", "P0002", "service_role")
            rejected(f"{fn} rejects waiting ticket", f"select public.{fn}('{ticket['id'] if ticket['id'] not in oldest else tickets[-1]['id']}','{unassigned}');", "P0002", "service_role")
        rejected("staff cannot hold two serving tickets", f"select public.call_next_ticket('{service}','{staff}');", "23514", "service_role")
        completed = finish(claimed[0], staff)
        skipped = finish(claimed[1], staff2, "skip_queue_ticket")
        check("completion preserves attribution and records timestamp", completed["status"] == "COMPLETED" and completed["completed_at"] and completed["served_by_staff_id"] == staff)
        check("skip is terminal with separate timestamp", skipped["status"] == "SKIPPED" and skipped["skipped_at"] and skipped["completed_at"] is None)
        rejected("cannot complete twice", f"select public.complete_queue_ticket('{completed['id']}','{staff}');", "P0002", "service_role")
        rejected("cannot skip completed ticket", f"select public.skip_queue_ticket('{completed['id']}','{staff}');", "P0002", "service_role")
        rejected("cannot complete skipped ticket", f"select public.complete_queue_ticket('{skipped['id']}','{staff2}');", "P0002", "service_role")

        one = create(single_service)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda employee: call(employee, single_service, True), [staff, staff2]))
        winners = [t for t in results if t]
        check("two simultaneous calls against one ticket have one winner", len(winners) == 1 and winners[0]["id"] == one["id"])
        finish(winners[0], winners[0]["served_by_staff_id"])
        check("empty queue returns no rows", call(staff, single_service) is None)

        # Same-staff double clicks must not consume two customers.
        create(single_service)
        create(single_service)

        def same_staff_call(_):
            try:
                return call(staff, single_service, True)
            except AssertionError as exc:
                assert "23514" in str(exc), str(exc)
                return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            double_click = list(pool.map(same_staff_call, range(2)))
        check("same-staff simultaneous calls have one winner", sum(t is not None for t in double_click) == 1)
        serving = next(t for t in double_click if t)

        def terminal_operation(operation):
            try:
                return finish(serving, staff, operation)
            except AssertionError as exc:
                assert "P0002" in str(exc), str(exc)
                return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            terminal = list(pool.map(terminal_operation, ["complete_queue_ticket", "skip_queue_ticket"]))
        check("simultaneous complete/skip has one terminal winner", sum(t is not None for t in terminal) == 1)

        # Seed is repeatable and adds no login credentials or customer records.
        seed = Path(__file__).resolve().parents[1] / "seed.sql"
        sql(seed.read_text(encoding="utf-8"))
        services_query = "select jsonb_agg(to_jsonb(s) order by id) from public.services s where organization_id='10000000-0000-4000-8000-000000000001';"
        first_seed = sql(services_query)
        sql(seed.read_text(encoding="utf-8"))
        # Managers may add services and locations to the demo organization.
        # Check the seed's stable IDs, while preserving all additional rows.
        seeded_count = sql("select count(*) from public.services where organization_id='10000000-0000-4000-8000-000000000001' and location_id='20000000-0000-4000-8000-000000000001' and id in ('30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000003');")[0]
        check("demo seed is idempotent", seeded_count == "3" and sql(services_query) == first_seed)
        print(f"\n{PASSED} database checks passed.", flush=True)
    finally:
        # Scope every deletion to this run's random fixture organization/user IDs.
        for table in ["queue_tickets", "service_daily_counters", "staff_assignments", "services", "staff", "locations", "managers"]:
            sql(f"delete from public.{table} where organization_id in ('{org}','{other_org}');")
        sql(f"delete from public.organizations where id in ('{org}','{other_org}'); delete from auth.users where id in ('{manager}','{other_manager}');")


if __name__ == "__main__":
    run()
