-- Read-only operational checks for the renewal pipeline. Run after the
-- assessment_renewal_pipeline migration and daily during the first week.
-- Dates use the same America/Sao_Paulo calendar as the renewal job.

-- Queue size and aging. Terminal records stay in the database after leaving
-- the board; this query intentionally counts their entire history.
WITH clock AS (
  SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS today
)
SELECT
  child.renewal_stage,
  count(*) AS total,
  count(*) FILTER (
    WHERE child.renewal_stage NOT IN ('renewed', 'not_renewed')
      AND parent.end_date < clock.today
  ) AS overdue_open,
  count(*) FILTER (
    WHERE child.renewal_stage = 'waiting_response'
      AND child.renewal_follow_up_at < clock.today
  ) AS overdue_follow_up,
  count(*) FILTER (
    WHERE child.renewal_stage = 'waiting_payment'
      AND child.auto_renewal
      AND nullif(child.asaas_payment_link, '') IS NULL
      AND nullif(child.asaas_pix_copy, '') IS NULL
      AND nullif(child.external_payment_link, '') IS NULL
  ) AS automatic_without_link,
  count(*) FILTER (
    WHERE child.renewal_stage IN ('renewed', 'not_renewed')
      AND child.renewal_resolved_at IS NOT NULL
      AND (child.renewal_resolved_at AT TIME ZONE 'America/Sao_Paulo')::date
          >= clock.today - 5
  ) AS terminal_in_board_window
FROM public.assessment_contracts AS child
LEFT JOIN public.assessment_contracts AS parent
  ON parent.id = child.parent_contract_id
CROSS JOIN clock
WHERE child.renewal_stage IS NOT NULL
GROUP BY child.renewal_stage
ORDER BY child.renewal_stage;

-- Review these rows before any correction. Some are operational follow-ups,
-- not financial inconsistencies. The report never updates payment, contract,
-- or pipeline state. An absent subscription link is tracked above, but is not
-- treated as evidence that the Asaas charge does not exist.
WITH clock AS (
  SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS today
), open_siblings AS (
  SELECT parent_contract_id, count(*) AS open_count
  FROM public.assessment_contracts
  WHERE parent_contract_id IS NOT NULL
    AND renewal_stage NOT IN ('renewed', 'not_renewed')
  GROUP BY parent_contract_id
)
SELECT
  child.id AS contract_id,
  child.contract_number,
  child.parent_contract_id,
  child.renewal_stage,
  child.status AS contract_status,
  child.payment_status,
  parent.end_date AS previous_term_end,
  issue.reason
FROM public.assessment_contracts AS child
LEFT JOIN public.assessment_contracts AS parent
  ON parent.id = child.parent_contract_id
LEFT JOIN open_siblings AS siblings
  ON siblings.parent_contract_id = child.parent_contract_id
CROSS JOIN clock
CROSS JOIN LATERAL unnest(array_remove(ARRAY[
  CASE WHEN child.parent_contract_id IS NOT NULL
      AND child.renewal_stage IS NULL
    THEN 'unclassified_child_review' END,
  CASE WHEN child.parent_contract_id IS NOT NULL
      AND child.renewal_stage IS NULL
      AND child.status = 'cancelled'
      AND child.payment_status = 'paid'
    THEN 'cancelled_paid_child_review' END,
  CASE WHEN child.renewal_stage NOT IN ('renewed', 'not_renewed')
      AND child.payment_status = 'paid'
    THEN 'paid_but_pipeline_open' END,
  CASE WHEN child.renewal_stage = 'renewed'
      AND child.payment_status IS DISTINCT FROM 'paid'
    THEN 'renewed_without_paid_payment' END,
  CASE WHEN child.renewal_stage = 'waiting_payment'
      AND child.parent_contract_id IS NULL
    THEN 'waiting_payment_without_parent' END,
  CASE WHEN child.renewal_stage IN ('renewed', 'not_renewed')
      AND child.renewal_resolved_at IS NULL
    THEN 'terminal_without_resolved_at' END,
  CASE WHEN child.renewal_stage NOT IN ('renewed', 'not_renewed')
      AND siblings.open_count > 1
    THEN 'multiple_open_children_for_parent' END,
  CASE WHEN child.renewal_stage = 'waiting_payment'
      AND child.payment_status <> 'paid'
      AND child.start_date < clock.today
    THEN 'new_term_payment_pending_follow_up' END,
  CASE WHEN child.renewal_stage = 'not_renewed'
      AND NOT EXISTS (
        SELECT 1
        FROM public.assessment_contract_event AS event
        WHERE event.contract_id = child.parent_contract_id
          AND event.event_type = 'renewal_declined'
          AND event.payload->>'discarded_contract_id' = child.id::text
      )
    THEN 'non_renewal_without_safe_resolution_event' END
], NULL)) AS issue(reason)
WHERE child.parent_contract_id IS NOT NULL
ORDER BY issue.reason, parent.end_date NULLS LAST, child.contract_number;

-- Parents whose date window is open but have no active renewal child. This is
-- diagnostic only: inspect cron failures, legacy decisions, and cancellations.
WITH clock AS (
  SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS today
)
SELECT
  parent.id AS parent_contract_id,
  parent.contract_number,
  parent.end_date,
  parent.auto_renewal,
  CASE WHEN parent.auto_renewal THEN 'automatic_D-5' ELSE 'manual_D-10' END AS policy,
  clock.today - parent.end_date AS days_after_end
FROM public.assessment_contracts AS parent
CROSS JOIN clock
WHERE parent.status IN ('active', 'overdue', 'on_leave')
  AND NOT coalesce(parent.renewal_generated, false)
  AND parent.scheduled_cancellation_date IS NULL
  AND parent.cancellation_date IS NULL
  AND nullif(btrim(parent.cancellation_reason), '') IS NULL
  AND parent.end_date <= clock.today + CASE WHEN parent.auto_renewal THEN 5 ELSE 10 END
  AND NOT EXISTS (
    SELECT 1
    FROM public.assessment_contracts AS child
    WHERE child.parent_contract_id = parent.id
      AND child.status IN ('draft', 'scheduled', 'active', 'overdue', 'on_leave')
  )
ORDER BY parent.end_date, parent.contract_number;
