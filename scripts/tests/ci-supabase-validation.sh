#!/usr/bin/env bash
# Run only through ci-supabase-loopback.py on the disposable Linux CI runner.
set -euo pipefail

test "${CI:-}" = true
test "${EON_TEST_EPHEMERAL:-}" = 1
test "${DOCKER_HOST:-}" = unix:///var/run/docker.sock
[[ "${EON_CI_NETWORK:-}" =~ ^eon-match-ci-[0-9]+-[0-9]+$ ]]

disable_local_jobs() {
  docker exec supabase_db_bsiljrrodgtmtdilnuxr \
    psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c 'SELECT cron.alter_job(jobid, active := false) FROM cron.job;'
  local active_jobs
  active_jobs="$(docker exec supabase_db_bsiljrrodgtmtdilnuxr \
    psql -X -U postgres -d postgres -tA -v ON_ERROR_STOP=1 \
    -c 'SELECT count(*) FROM cron.job WHERE active;')"
  test "$active_jobs" = 0
}

echo '::group::Bootstrap isolated Supabase'
supabase start --network-id "$EON_CI_NETWORK"
python3 scripts/tests/ci-supabase-isolation.py
disable_local_jobs
echo '::endgroup::'

echo '::group::Replay all migrations in clean local database'
supabase db reset --local --no-seed --network-id "$EON_CI_NETWORK"
python3 scripts/tests/ci-supabase-isolation.py
disable_local_jobs
echo '::endgroup::'

echo '::group::Database regression tests'
supabase test db --local --network-id "$EON_CI_NETWORK"
echo '::endgroup::'

echo '::group::Concurrent communication actions'
python3 scripts/tests/communication_case_concurrency.py
echo '::endgroup::'

echo '::group::Concurrent coach match actions'
python3 scripts/tests/coach-match-concurrency.py
echo '::endgroup::'
