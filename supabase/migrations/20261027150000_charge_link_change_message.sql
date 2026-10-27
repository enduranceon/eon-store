-- Cobrança com link novo e mensagem do pro rata.
--
-- 1. Trocar o link da cobrança externa do contrato volta a mensagem para "não
--    enviada": a pessoa ainda não recebeu o link novo. Antes a Central achava
--    que a cobrança já tinha sido enviada e, antes do vencimento, mostrava o
--    texto de "vencida há" sem os dias.
-- 2. A cobrança de um contrato com pro rata diz o período proporcional.

-- Contexto do contrato: pro rata.
DO $do$
DECLARE
  v_def text;
  v_anchor constant text := $a$'end_date', c.end_date,$a$;
BEGIN
  v_def := pg_get_functiondef('eon_private.communication_source_context(text,uuid)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'communication_source_context: end_date do contrato não encontrado uma única vez';
  END IF;
  v_def := replace(v_def, v_anchor, $a$'end_date', c.end_date,
      'prorata', c.plan_snapshot->'prorata',$a$);
  EXECUTE v_def;
END
$do$;

-- {referente}: "(ASS-000000, proporcional de 28/10 a 06/11)".
DO $do$
DECLARE
  v_def text;
  v_declare constant text := $a$  v_about text;
$a$;
  v_overdue constant text := $a$  -- Cobrança vencida: há quantos dias e a que se refere.
$a$;
  v_about constant text := $a$|| COALESCE(' (' || v_ref || ')', '')$a$;
BEGIN
  v_def := pg_get_functiondef('eon_private.communication_template_context(jsonb)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_declare, ''))) / length(v_declare) <> 1
     OR (length(v_def) - length(replace(v_def, v_overdue, ''))) / length(v_overdue) <> 1
     OR (length(v_def) - length(replace(v_def, v_about, ''))) / length(v_about) <> 1 THEN
    RAISE EXCEPTION 'communication_template_context: trechos do referente não encontrados uma única vez';
  END IF;
  v_def := replace(v_def, v_declare, $a$  v_about text;
  v_prorata text;
$a$);
  v_def := replace(v_def, v_overdue, $a$  -- Pro rata do plano mensal: o primeiro período vai até a véspera do dia do ciclo.
  IF jsonb_typeof(p_context->'prorata') = 'object'
     AND COALESCE(p_context->'prorata'->>'start_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
     AND COALESCE(p_context->'prorata'->>'end_date', '') ~ '^\d{4}-\d{2}-\d{2}$' THEN
    v_prorata := 'proporcional de '
      || to_char((p_context->'prorata'->>'start_date')::date, 'DD/MM') || ' a '
      || to_char((p_context->'prorata'->>'end_date')::date - 1, 'DD/MM');
  END IF;
  -- Cobrança vencida: há quantos dias e a que se refere.
$a$);
  v_def := replace(v_def, v_about,
    $a$|| COALESCE(' (' || NULLIF(concat_ws(', ', v_ref, v_prorata), '') || ')', '')$a$);
  EXECUTE v_def;
END
$do$;

-- Link novo na cobrança externa do contrato: a mensagem volta a "não enviada".
DO $do$
DECLARE
  v_def text;
  v_anchor constant text := $a$      external_invoice_number = v_clean_invoice,
$a$;
BEGIN
  v_def := pg_get_functiondef(
    'public.save_assessment_contract_external_charge(uuid,text,date,text,text,text,timestamptz,uuid)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'save_assessment_contract_external_charge: atualização do contrato não encontrada uma única vez';
  END IF;
  v_def := replace(v_def, v_anchor, $a$      external_invoice_number = v_clean_invoice,
      payment_message_sent_at = CASE
        WHEN nullif(v_previous.external_payment_link, '') IS DISTINCT FROM p_external_link THEN NULL
        ELSE v_previous.payment_message_sent_at END,
$a$);
  EXECUTE v_def;
END
$do$;
