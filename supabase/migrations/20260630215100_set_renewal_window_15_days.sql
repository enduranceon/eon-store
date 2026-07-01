-- Align the renewal communication rule with the 15-day operational window.
-- The slug is intentionally kept for history compatibility with existing events.
UPDATE public.communication_rules
SET days_offset = -15,
    updated_at = NOW()
WHERE slug = 'renewal-reminder-14d'
  AND task_kind = 'renewal_reminder';
