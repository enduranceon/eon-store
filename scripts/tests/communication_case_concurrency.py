#!/usr/bin/env python3
"""Exercise communication actions with two real PostgreSQL sessions.

Run only against the disposable Supabase database used by the migrations CI job.
The committed fictitious rows are discarded by `supabase stop --no-backup`.
PostgreSQL's append-only history trigger is deliberately left enabled.

Required environment: EON_TEST_EPHEMERAL=1, PGHOST=127.0.0.1,
PGPORT=54322, PGDATABASE=postgres, PGUSER=postgres, PGPASSWORD=postgres.
"""

from __future__ import annotations

import json
import os
import select
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass


PSQL = shutil.which("psql")
ACTOR_A = "a1000000-0000-4000-a000-000000000011"
ACTOR_B = "a1000000-0000-4000-a000-000000000012"
WAIT_SECONDS = 12


def sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def require_ephemeral_local_database() -> dict[str, str]:
    expected = {
        "EON_TEST_EPHEMERAL": "1",
        "PGHOST": "127.0.0.1",
        "PGPORT": "54322",
        "PGDATABASE": "postgres",
        "PGUSER": "postgres",
    }
    for name, value in expected.items():
        if os.environ.get(name) != value:
            raise RuntimeError(f"Refusing to run: {name} must be {value!r}")
    if not os.environ.get("PGPASSWORD"):
        raise RuntimeError("Refusing to run without a password for the disposable local DB")
    if not PSQL:
        raise RuntimeError("psql is required (install postgresql-client in CI)")
    env = os.environ.copy()
    for name in ("PGSERVICE", "PGSERVICEFILE", "PGOPTIONS", "PGTARGETSESSIONATTRS"):
        env.pop(name, None)
    env["PGSSLMODE"] = "disable"
    env["PGCONNECT_TIMEOUT"] = "5"
    env["PGAPPNAME"] = "eon_case_concurrency_controller"
    return env


def psql_args() -> list[str]:
    return [PSQL, "-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"]


def query(sql: str, env: dict[str, str]) -> str:
    result = subprocess.run(
        [*psql_args(), "-c", sql], env=env, capture_output=True, text=True,
        timeout=30, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"psql query failed: {result.stderr.strip()}")
    return result.stdout.strip()


def check_target(env: dict[str, str]) -> None:
    result = query(
        "SELECT current_database() || '|' || current_user || '|' || "
        "COALESCE((SELECT value->>'enabled' FROM public.communication_settings "
        "WHERE key='cases_rollout'),'missing')",
        env,
    )
    if result != "postgres|postgres|false":
        raise RuntimeError(
            "Refusing to run: expected fresh local postgres database and disabled case rollout; "
            f"got {result!r}"
        )


@dataclass
class Fixture:
    source_id: str
    case_id: str
    version: int
    fingerprint: str


def create_fixture(env: dict[str, str], label: str) -> Fixture:
    source_id = str(uuid.uuid4())
    order_number = "EST-CASE-RACE-" + source_id[:8]
    query(
        "INSERT INTO public.stock_orders "
        "(id,order_number,customer_name,customer_whatsapp,total_value,payment_status,"
        "due_date,asaas_payment_link,payment_message_sent_at) VALUES ("
        f"{sql_string(source_id)}::uuid,{sql_string(order_number)},"
        f"{sql_string('Pessoa Fictícia ' + label)},'11999990001',150,'charge_sent',"
        "(now() AT TIME ZONE 'America/Sao_Paulo')::date-3,"
        "'https://example.test/pay/race',now()-interval '4 days')",
        env,
    )
    case_id = query(
        "SELECT id::text FROM public.communication_cases WHERE source_type='stock' "
        f"AND source_id={sql_string(source_id)}::uuid AND purpose='billing' "
        "AND status='open'",
        env,
    )
    if not case_id or "\n" in case_id:
        raise AssertionError(f"Expected one open case for fictitious order {source_id}")
    detail = json.loads(query(
        f"SELECT public.get_communication_case({sql_string(case_id)}::uuid)::text", env,
    ))
    projection = detail["case"]
    fingerprint = projection["source_fingerprint"]
    if len(fingerprint) != 32 or not projection["version"]:
        raise AssertionError("Case snapshot lacks version or source fingerprint")
    return Fixture(source_id, case_id, int(projection["version"]), fingerprint)


def action_sql(fixture: Fixture, request: dict, key: str, actor: str) -> str:
    payload = json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return (
        "SELECT public.apply_communication_case_action("
        f"{sql_string(fixture.case_id)}::uuid,{sql_string(payload)}::jsonb,"
        f"{sql_string(key)},{sql_string(actor)}::uuid)->>'replayed'"
    )


class InteractiveSession:
    def __init__(self, env: dict[str, str], name: str):
        session_env = env.copy()
        session_env["PGAPPNAME"] = name
        self.process = subprocess.Popen(
            psql_args(), env=session_env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
        )
        self.buffer = b""

    def send(self, sql: str) -> None:
        if self.process.poll() is not None:
            raise RuntimeError("psql session exited before command")
        assert self.process.stdin is not None
        self.process.stdin.write((sql.rstrip() + "\n").encode())
        self.process.stdin.flush()

    def line(self, timeout: int = WAIT_SECONDS) -> str:
        assert self.process.stdout is not None
        deadline = time.monotonic() + timeout
        while True:
            if b"\n" in self.buffer:
                value, self.buffer = self.buffer.split(b"\n", 1)
                return value.decode().strip()
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("Timed out waiting for psql session output")
            ready, _, _ = select.select([self.process.stdout], [], [], left)
            if ready:
                data = os.read(self.process.stdout.fileno(), 65536)
                if not data:
                    error = self.process.stderr.read().decode().strip()
                    raise RuntimeError(f"psql session exited: {error}")
                self.buffer += data

    def close(self) -> None:
        if self.process.poll() is None:
            try:
                self.send("ROLLBACK;")
                self.process.stdin.close()
                self.process.wait(timeout=5)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.process.terminate()
                self.process.wait(timeout=5)


def wait_until_blocked(env: dict[str, str], blocked_app: str, blocker_pid: int,
                       worker: subprocess.Popen) -> None:
    # The observed PostgreSQL blocker is the barrier; elapsed time is only a timeout.
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        if worker.poll() is not None:
            stdout, stderr = worker.communicate()
            raise AssertionError(
                f"Second action completed before lock contention: {stdout.strip()} {stderr.strip()}"
            )
        blockers = query(
            "SELECT COALESCE(array_to_string(pg_blocking_pids(pid),','),'') "
            "FROM pg_stat_activity WHERE application_name="
            f"{sql_string(blocked_app)} AND state='active' ORDER BY backend_start DESC LIMIT 1",
            env,
        )
        if str(blocker_pid) in blockers.split(","):
            return
        time.sleep(0.05)
    raise TimeoutError("Second action never waited on the first PostgreSQL session")


def verify_one_action(env: dict[str, str], fixture: Fixture, keys: list[str]) -> None:
    result = query(
        "SELECT c.version::text || '|' || "
        "(SELECT count(*) FROM public.communication_case_events e "
        "WHERE e.case_id=c.id AND e.event_type='return_scheduled')::text || '|' || "
        "(SELECT count(*) FROM public.communication_case_commands x "
        "WHERE x.case_id=c.id)::text FROM public.communication_cases c "
        f"WHERE c.id={sql_string(fixture.case_id)}::uuid",
        env,
    )
    expected = f"{fixture.version + 1}|1|1"
    if result != expected:
        raise AssertionError(f"Expected one committed action ({expected}), got {result!r}")
    commands = query(
        "SELECT idempotency_key FROM public.communication_case_commands WHERE case_id="
        f"{sql_string(fixture.case_id)}::uuid ORDER BY idempotency_key",
        env,
    ).splitlines()
    if commands != keys:
        raise AssertionError(f"Unexpected command keys: {commands!r}; wanted {keys!r}")


def race(env: dict[str, str], fixture: Fixture, *, replay: bool, next_date: str) -> None:
    label = "replay" if replay else "conflict"
    key_a = f"case:ci:{label}:{uuid.uuid4().hex}"
    key_b = key_a if replay else f"case:ci:loser:{uuid.uuid4().hex}"
    actor_a = ACTOR_A
    actor_b = ACTOR_A if replay else ACTOR_B
    request = {
        "action": "return_scheduled",
        "expected_version": fixture.version,
        "expected_source_fingerprint": fixture.fingerprint,
        "source_ui": "concurrency_test",
        "next_action_at": next_date,
        "note": "Retorno fictício confirmado no teste local",
    }
    first_app = f"eon_case_first_{uuid.uuid4().hex[:8]}"
    second_app = f"eon_case_second_{uuid.uuid4().hex[:8]}"
    first = InteractiveSession(env, first_app)
    second = None
    try:
        first.send("BEGIN;")
        first.send("SET LOCAL ROLE service_role;")
        first.send("SELECT pg_backend_pid();")
        first_pid = int(first.line())
        first.send(action_sql(fixture, request, key_a, actor_a) + ";")
        if first.line() != "false":
            raise AssertionError("First action unexpectedly replayed")

        second_env = env.copy()
        second_env["PGAPPNAME"] = second_app
        second_sql = (
            "BEGIN; SET LOCAL ROLE service_role; SET LOCAL lock_timeout='20s'; "
            + action_sql(fixture, request, key_b, actor_b) + "; COMMIT;"
        )
        second = subprocess.Popen(
            [*psql_args(), "-c", second_sql], env=second_env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        wait_until_blocked(env, second_app, first_pid, second)
        first.send("COMMIT;")
        first.send("SELECT 'COMMITTED';")
        if first.line() != "COMMITTED":
            raise AssertionError("First action did not commit")

        out, err = second.communicate(timeout=WAIT_SECONDS)
        if replay:
            if second.returncode != 0 or out.strip() != "true":
                raise AssertionError(f"Identical retry did not replay: {out.strip()} {err.strip()}")
        elif second.returncode == 0 or "Acompanhamento alterado" not in err:
            raise AssertionError(f"Stale operator did not conflict: {out.strip()} {err.strip()}")
        verify_one_action(env, fixture, [key_a])
        print(f"PASS {label}: observed PostgreSQL blocking, one event, one command")
    finally:
        first.close()
        if second is not None and second.poll() is None:
            second.terminate()
            second.communicate(timeout=5)


def main() -> None:
    env = require_ephemeral_local_database()
    check_target(env)
    fixture_conflict = create_fixture(env, "concorrência 1")
    fixture_replay = create_fixture(env, "concorrência 2")
    # Only the disposable local DB is activated, after the fictitious rows exist.
    query("UPDATE public.communication_settings SET value=jsonb_build_object("
          "'enabled',true,'enabled_at',now()) WHERE key='cases_rollout'", env)
    try:
        next_date = query(
            "SELECT ((now() AT TIME ZONE 'America/Sao_Paulo')::date+2)::text", env,
        )
        race(env, fixture_conflict, replay=False, next_date=next_date)
        race(env, fixture_replay, replay=True, next_date=next_date)
    finally:
        query("UPDATE public.communication_settings SET value=jsonb_build_object("
              "'enabled',false,'enabled_at',NULL) WHERE key='cases_rollout'", env)
    print("PASS rollout restored to disabled; CI disposes the local database")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FAIL communication case concurrency: {exc}", file=sys.stderr)
        sys.exit(1)
