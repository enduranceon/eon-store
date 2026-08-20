-- Operational expenses for the Events module. Revenue comes from
-- event_registrations; expenses live here so each event can show its own
-- contribution/result without mixing with general cash-flow records.
CREATE TABLE public.event_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  category TEXT,
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  expense_date DATE NOT NULL DEFAULT current_date,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX event_expenses_event_id_idx
  ON public.event_expenses(event_id);
CREATE INDEX event_expenses_expense_date_idx
  ON public.event_expenses(expense_date DESC);

CREATE TRIGGER touch_event_expenses_updated_at
  BEFORE UPDATE ON public.event_expenses
  FOR EACH ROW EXECUTE FUNCTION public.touch_events_domain_updated_at();

ALTER TABLE public.event_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY event_expenses_admin_read ON public.event_expenses
  FOR SELECT TO authenticated USING (eon_private.is_app_admin());
CREATE POLICY event_expenses_admin_only ON public.event_expenses
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (eon_private.is_app_admin()) WITH CHECK (eon_private.is_app_admin());

REVOKE ALL ON TABLE public.event_expenses FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.event_expenses TO service_role;
