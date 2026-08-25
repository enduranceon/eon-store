-- Read-only operational review for every billing surface.
-- Run this query before manually correcting historic records. It does not mutate data.
-- "external_charge_registered_pending_message" is expected while the operator still
-- needs to send the payment message; it is not a financial inconsistency by itself.

WITH billing_records AS (
  SELECT
    'presale'::text AS order_type,
    o.id AS record_id,
    o.order_number::text AS reference,
    o.payment_status,
    o.payment_method,
    o.due_date,
    o.manual_payment,
    o.payment_message_sent_at,
    coalesce(o.updated_date, o.created_date) AS updated_at,
    nullif(o.external_payment_link, '') AS external_payment_link,
    (
      nullif(o.asaas_charge_id, '') IS NOT NULL OR
      nullif(o.asaas_payment_link, '') IS NOT NULL OR
      nullif(o.asaas_pix_copy, '') IS NOT NULL OR
      nullif(o.asaas_pix_qrcode, '') IS NOT NULL
    ) AS has_native_charge
  FROM public.presale_orders o

  UNION ALL

  SELECT
    'stock'::text,
    o.id,
    o.order_number::text,
    o.payment_status,
    o.payment_method,
    o.due_date,
    o.manual_payment,
    o.payment_message_sent_at,
    coalesce(o.updated_date, o.created_date),
    nullif(o.external_payment_link, ''),
    (
      nullif(o.asaas_charge_id, '') IS NOT NULL OR
      nullif(o.asaas_payment_link, '') IS NOT NULL OR
      nullif(o.asaas_pix_copy, '') IS NOT NULL OR
      nullif(o.asaas_pix_qrcode, '') IS NOT NULL
    )
  FROM public.stock_orders o

  UNION ALL

  SELECT
    'contract'::text,
    c.id,
    c.contract_number::text,
    c.payment_status,
    c.payment_method,
    c.due_date,
    c.manual_payment,
    c.payment_message_sent_at,
    c.updated_at,
    nullif(c.external_payment_link, ''),
    (
      nullif(c.asaas_charge_id, '') IS NOT NULL OR
      nullif(c.asaas_payment_link, '') IS NOT NULL OR
      nullif(c.asaas_pix_copy, '') IS NOT NULL OR
      nullif(c.asaas_pix_qrcode, '') IS NOT NULL
    )
  FROM public.assessment_contracts c

  UNION ALL

  SELECT
    'event'::text,
    r.id,
    r.registration_number::text,
    r.payment_status,
    r.payment_method,
    r.due_date,
    r.manual_payment,
    r.payment_message_sent_at,
    r.updated_at,
    nullif(r.external_payment_link, ''),
    (
      nullif(r.asaas_charge_id, '') IS NOT NULL OR
      nullif(r.asaas_payment_link, '') IS NOT NULL OR
      nullif(r.asaas_pix_copy, '') IS NOT NULL OR
      nullif(r.asaas_pix_qrcode, '') IS NOT NULL
    )
  FROM public.event_registrations r
), review_flags AS (
  SELECT
    b.*,
    issue.review_reason
  FROM billing_records b
  CROSS JOIN LATERAL unnest(array_remove(ARRAY[
    CASE
      WHEN b.external_payment_link IS NOT NULL
       AND b.payment_message_sent_at IS NULL
       AND coalesce(b.payment_status, '') NOT IN ('paid', 'refunded', 'cancelled')
      THEN 'external_charge_registered_pending_message'
    END,
    CASE
      WHEN b.payment_message_sent_at IS NOT NULL
       AND b.external_payment_link IS NULL
       AND NOT b.has_native_charge
       AND coalesce(b.payment_status, '') NOT IN ('paid', 'refunded', 'cancelled')
      THEN 'message_recorded_without_charge'
    END,
    CASE
      WHEN b.external_payment_link IS NOT NULL
       AND b.has_native_charge
      THEN 'external_and_asaas_charge_present'
    END,
    CASE
      WHEN coalesce(b.manual_payment, false)
       AND coalesce(b.payment_status, '') NOT IN ('paid', 'refunded', 'cancelled')
      THEN 'manual_payment_with_open_status'
    END
  ], NULL)) AS issue(review_reason)
)
SELECT
  order_type,
  review_reason,
  record_id,
  reference,
  payment_status,
  payment_method,
  due_date,
  payment_message_sent_at,
  updated_at
FROM review_flags
ORDER BY
  CASE review_reason
    WHEN 'message_recorded_without_charge' THEN 1
    WHEN 'external_and_asaas_charge_present' THEN 2
    WHEN 'manual_payment_with_open_status' THEN 3
    ELSE 4
  END,
  updated_at DESC NULLS LAST;
