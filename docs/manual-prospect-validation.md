# Manual prospect creation

## Findings

Read-only inspection of the canonical Supabase project on 2026-09-21 confirmed two independent blockers:

- The RPC used double-escaped regular expressions in ordinary PostgreSQL strings. With `standard_conforming_strings=on`, a valid phone failed validation; CPF normalization and email validation were also affected.
- The creation ledger allowed only `admin_contract` and `public_enrollment`, although this RPC writes `manual_prospect`. Fixing the regex alone would still fail the check constraint.

Both failures were reproduced with fictitious contacts in an isolated PostgreSQL-compatible runtime before executing the corrected function. No production customers or contracts were created or modified.

## Changes

- Migration `20260921192544` corrects the regex, extends the ledger allowlist, and adds a service-only RPC overload accepting optional gender and birth date. The old signature delegates to the new one, without default-argument ambiguity.
- The full clean-install CI exposed missing explicit backend table grants. The migration grants only the required SELECT/INSERT/UPDATE privileges to `service_role`; browser roles and RLS policies remain unchanged. Production already had these backend privileges.
- Existing customer columns store the profile fields. Birth dates must be valid calendar dates from 1900 through today; gender uses the existing masculine/feminine/other values. Both fields remain optional.
- Missing profile values can be filled on an existing customer. Conflicting values, conflicting CPFs and contacts matching different customers require review instead of silently overwriting or arbitrarily linking records.
- Contact formatting is normalized for matching. Manual creations lock each supplied identity in a stable order; this does not replace a cross-application customer deduplication policy.
- The frontend validates email, CPF length, dates and integer installments before submission. A retry with the same payload reuses its operation key while the modal remains open. A failed options load is visible and retryable.
- The operation remains a draft prospect, with no charge creation, payment, activation, Asaas call or historical reclassification. Existing manual billing is unchanged.

## Verification

- `npm run test:unit`: 123 tests passed, including 21 new form cases and the pending return/MRR regression suite.
- Edge tests with network denied: 225 tests and 30 steps passed, including 16 new prospect cases.
- `supabase/tests/assessment_manual_prospect_test.sql`: 49 assertions passed in isolated PGlite with a focused schema, exercising the actual new migration, legacy signature, permissions, normalization, profile persistence, conflict handling, atomic failure and idempotency. This is not a replay of the entire Supabase migration chain.
- Browser checks at 1440, 390 and 320 px: options-load recovery, validation, payload, same-key retry, updated board and profile display passed. Every backend request was intercepted; no production writes. Screenshots inspected.
- Build passed. Lint passed with the same 12 pre-existing warnings.

## Release

Not published or applied to production. Keep the pending return-classification changes intact.

1. Review the diff and run the full Supabase migration/pgTAP job in CI. Docker is not installed on the local machine; the focused SQL tests do not replace that gate.
2. Deploy through the existing GitHub workflow: database migration first, then `api-v1`, then frontend. A frontend-only preview still uses the old production backend and cannot validate this new flow safely.
3. Verify the migration and both RPC signatures/permissions read-only. Do not create fictitious customers in production.
4. After release, monitor the first authorized real manual prospect creation. Check that it appears in `new`, profile fields persist, and no charge was created.

For an application rollback, the database migration can remain: it retains the old RPC signature and fixes both original blockers. Do not narrow the ledger allowlist again once manual operations have been recorded.
