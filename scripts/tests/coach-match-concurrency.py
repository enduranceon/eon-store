#!/usr/bin/env python3
"""Test match race conditions with real, isolated PostgreSQL sessions.

Local disposable CI database ONLY. Requires EON_TEST_EPHEMERAL=1 and the same
127.0.0.1:54322 connection variables as communication_case_concurrency.py.
Creates fictitious coaches/users, never contracts/orders/payments, and performs
no network calls other than local PostgreSQL. CI destroys the database after use.
"""

from __future__ import annotations

import json
import subprocess
import sys
import uuid
from dataclasses import dataclass

from communication_case_concurrency import (
    InteractiveSession,
    WAIT_SECONDS,
    psql_args,
    query,
    require_ephemeral_local_database,
    sql_string,
    wait_until_blocked,
)


ANSWERS = {
    "version": 1,
    "focus_goals": ["start", "evolve"],
    "focus_levels": ["beginner", "regular"],
    "service_formats": ["florianopolis", "online"],
    "communication_style": "close",
    "approach": "Acompanhamento fictício respeitando cada rotina individual.",
    "experience": "Perfil fictício para teste local de concorrência.",
}


@dataclass
class Fixture:
    coach: str
    actor: str
    token: str
    invite: str


def uuid_sql(value: str) -> str:
    return sql_string(value) + "::uuid"


def issue_sql(f: Fixture, token: str) -> str:
    return (
        "SELECT public.issue_assessment_coach_match_invite("
        f"{uuid_sql(f.coach)},{sql_string(token)},"
        f"clock_timestamp()+interval '1 day',{uuid_sql(f.actor)})::text"
    )


def submit_sql(f: Fixture, style: str = "close") -> str:
    payload = json.dumps({**ANSWERS, "communication_style": style}, ensure_ascii=False)
    return (
        "SELECT public.submit_assessment_coach_match_answers("
        f"{sql_string(f.token)},{sql_string(payload)}::jsonb)::text"
    )


def review_sql(f: Fixture, submission: str, decision: str) -> str:
    return (
        "SELECT public.review_assessment_coach_match_submission("
        f"{uuid_sql(f.coach)},{uuid_sql(submission)},"
        f"{sql_string(decision)},{uuid_sql(f.actor)})::text"
    )


def revoke_sql(f: Fixture) -> str:
    return (
        "SELECT public.revoke_assessment_coach_match_invite("
        f"{uuid_sql(f.coach)},{uuid_sql(f.invite)})::text"
    )


def as_service(sql: str) -> str:
    return "BEGIN; SET LOCAL ROLE service_role; " + sql.rstrip(";") + "; COMMIT;"


def fixture(env: dict[str, str], label: str) -> Fixture:
    coach, actor = str(uuid.uuid4()), str(uuid.uuid4())
    token = uuid.uuid4().hex + uuid.uuid4().hex
    query(
        "INSERT INTO auth.users(id,email) VALUES ("
        f"{uuid_sql(actor)},{sql_string(actor + '@example.test')}); "
        "INSERT INTO public.assessment_coaches(id,name,email,role,active,public_visible) "
        f"VALUES ({uuid_sql(coach)},{sql_string('Match fictício ' + label)},"
        f"{sql_string(coach + '@example.test')},'pleno',true,true)", env,
    )
    f = Fixture(coach, actor, token, "")
    f.invite = json.loads(query(as_service(issue_sql(f, token)), env))["id"]
    return f


def first_draft(env: dict[str, str], f: Fixture) -> str:
    submission = json.loads(query(as_service(submit_sql(f)), env))["id"]
    # Alter only local fixture timestamps to avoid sleeping for a minute.
    query(
        "UPDATE public.assessment_coach_match_submissions "
        "SET submitted_at=clock_timestamp()-interval '2 minutes' "
        f"WHERE coach_id={uuid_sql(f.coach)}; "
        "UPDATE public.assessment_coach_match_invites "
        "SET last_submitted_at=clock_timestamp()-interval '2 minutes' "
        f"WHERE coach_id={uuid_sql(f.coach)}", env,
    )
    return submission


def race(env: dict[str, str], label: str, first_sql: str, second_sql: str,
         error_code: str | None = None) -> tuple[dict, dict | None]:
    """Use observed pg_blocking_pids, never timing guesses, as the race barrier."""
    first_app = "eon_match_first_" + uuid.uuid4().hex[:8]
    second_app = "eon_match_second_" + uuid.uuid4().hex[:8]
    first = InteractiveSession(env, first_app)
    second = None
    try:
        first.send("BEGIN; SET LOCAL ROLE service_role; SET LOCAL lock_timeout='20s';")
        first.send("SELECT pg_backend_pid();")
        first_pid = int(first.line())
        first.send(first_sql + ";")
        first_result = json.loads(first.line())

        second_env = {**env, "PGAPPNAME": second_app}
        second = subprocess.Popen(
            [*psql_args(), "-v", "VERBOSITY=verbose", "-c", as_service(
                "SET LOCAL lock_timeout='20s'; " + second_sql)],
            env=second_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        wait_until_blocked(env, second_app, first_pid, second)
        first.send("COMMIT; SELECT 'COMMITTED';")
        if first.line() != "COMMITTED":
            raise AssertionError("First transaction did not commit")
        output, error = second.communicate(timeout=WAIT_SECONDS)
        if error_code:
            if second.returncode == 0 or error_code not in error:
                raise AssertionError(f"{label}: expected {error_code}; got {output} {error}")
            second_result = None
        else:
            if second.returncode:
                raise AssertionError(f"{label}: second action failed: {error}")
            second_result = json.loads(output.strip())
        print(f"PASS {label}: observed PostgreSQL lock contention")
        return first_result, second_result
    finally:
        first.close()
        if second is not None and second.poll() is None:
            second.terminate()
            second.communicate(timeout=5)


def equal(actual: str, expected: str, description: str) -> None:
    if actual != expected:
        raise AssertionError(f"{description}: expected {expected!r}, got {actual!r}")


def count_submissions(env: dict[str, str], f: Fixture) -> str:
    return query("SELECT count(*) FROM public.assessment_coach_match_submissions "
                 f"WHERE coach_id={uuid_sql(f.coach)}", env)


def financial_snapshot(env: dict[str, str]) -> str:
    # Hash row contents, so same-count updates are detected as well as inserts.
    tables = ["assessment_contracts", "presale_customers", "assessment_plans",
              "assessment_coach_site_plans", "asaas_payments", "presale_orders",
              "stock_orders", "payout_monthly_closings", "payout_monthly_statement_items"]
    parts = [
        "SELECT " + sql_string(table) + " || ':' || md5(coalesce("
        "string_agg(to_jsonb(t)::text,chr(10) ORDER BY to_jsonb(t)::text),'')) "
        f"FROM public.{table} t" for table in tables
    ]
    return query(" UNION ALL ".join(parts), env)


def main() -> None:
    env = require_ephemeral_local_database()
    equal(query("SELECT current_database() || '|' || current_user", env),
          "postgres|postgres", "disposable database identity")
    before = financial_snapshot(env)

    f = fixture(env, "double submit")
    race(env, "simultaneous submit admits only one", submit_sql(f), submit_sql(f), "PT429")
    equal(count_submissions(env, f), "1", "double-submit history count")

    f = fixture(env, "revoke then submit")
    race(env, "revoke blocks an in-flight submit", revoke_sql(f), submit_sql(f), "PT410")
    equal(count_submissions(env, f), "0", "revoked submission leaves no row")

    f = fixture(env, "rotate then submit")
    replacement = uuid.uuid4().hex + uuid.uuid4().hex
    race(env, "rotation invalidates old token atomically", issue_sql(f, replacement), submit_sql(f), "PT410")
    equal(count_submissions(env, f), "0", "rotated token leaves no row")

    f = fixture(env, "parallel invite")
    token_a, token_b = uuid.uuid4().hex * 2, uuid.uuid4().hex * 2
    race(env, "parallel invites serialize", issue_sql(f, token_a), issue_sql(f, token_b))
    equal(query("SELECT token_hash FROM public.assessment_coach_match_invites "
                f"WHERE coach_id={uuid_sql(f.coach)} AND revoked_at IS NULL", env),
          token_b, "only the last issued link is current")

    f = fixture(env, "draft then review")
    old = first_draft(env, f)
    race(env, "new draft makes waiting approval stale", submit_sql(f, "balanced"),
         review_sql(f, old, "approved"), "PT409")
    equal(query("SELECT status FROM public.assessment_coach_match_submissions "
                f"WHERE id={uuid_sql(old)}", env), "superseded", "stale draft status")
    equal(query("SELECT count(*) FROM public.list_public_coach_match_profiles() "
                f"WHERE coach_id={uuid_sql(f.coach)}", env), "0", "no stale draft published")

    f = fixture(env, "review then draft")
    old = first_draft(env, f)
    _, fresh = race(env, "approval survives subsequent pending draft", review_sql(f, old, "approved"),
                    submit_sql(f, "autonomy"))
    equal(query("SELECT published_submission_id::text FROM public.assessment_coach_match_state "
                f"WHERE coach_id={uuid_sql(f.coach)}", env), old, "approved pointer is stable")
    equal(query("SELECT latest_submission_id::text FROM public.assessment_coach_match_state "
                f"WHERE coach_id={uuid_sql(f.coach)}", env), fresh["id"], "latest pointer is new draft")

    f = fixture(env, "parallel review")
    old = first_draft(env, f)
    race(env, "only first review wins", review_sql(f, old, "approved"),
         review_sql(f, old, "rejected"), "PT409")
    equal(query("SELECT status FROM public.assessment_coach_match_submissions "
                f"WHERE id={uuid_sql(old)}", env), "approved", "winner is not overwritten")
    equal(financial_snapshot(env), before, "all financial table snapshots stay unchanged")
    print("PASS all match races and financial isolation; CI disposes the local fixtures")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FAIL coach match concurrency: {exc}", file=sys.stderr)
        sys.exit(1)
