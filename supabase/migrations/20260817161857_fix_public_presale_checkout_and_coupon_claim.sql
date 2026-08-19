-- Dois defeitos encontrados por plpgsql_check, ambos no fluxo público:
--
-- 1) eon_private.create_public_presale_order gravava em presale_customers.trainer
--    e presale_orders.checkout_trainer. Essas colunas foram removidas em
--    12/jun (cleanup_legacy_trainer_columns) e a função nunca foi atualizada.
--    Como as escritas são incondicionais, TODO checkout público de pré-venda
--    falhava desde então.
--
--    O campo "Treinador" continua sendo coletado no formulário público, mas
--    não existe mais coluna destino: presale_customers/presale_orders agora
--    têm coach_id (FK para assessment_coaches), enquanto o formulário envia
--    texto vindo de presale_trainers — tabelas diferentes, sem mapeamento
--    confiável. Aqui o dado deixa de ser gravado; ligar o treinador ao coach
--    é decisão de produto, não deste reparo.
--
-- 2) eon_private.claim_public_coupon: o RETURNS TABLE declara uma saída
--    chamada coupon_id, que colide com coupon_uses.coupon_id no WHERE.
--    Postgres recusa com 42702 (referência ambígua). Só afeta cupom com
--    limite por cliente — que é o caso do cupom ativo COACHEON.
--
-- Método: parte da definição vigente no banco (pg_get_functiondef), aplica
-- substituições pontuais e aborta se alguma não casar, para nunca aplicar
-- uma correção parcial.

DO $do$
DECLARE
  v_def TEXT;
  v_new TEXT;
BEGIN
  ---------------------------------------------------------------- 1
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'eon_private' AND p.proname = 'create_public_presale_order';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'create_public_presale_order não encontrada';
  END IF;

  v_new := replace(v_def, ', trainer = COALESCE(v_trainer, trainer)', '');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'padrão 1/4 não encontrado (UPDATE ... trainer)';
  END IF;

  v_def := v_new;
  v_new := replace(v_def,
    '(full_name, whatsapp, email, trainer) VALUES (v_name, v_phone, v_email, v_trainer)',
    '(full_name, whatsapp, email) VALUES (v_name, v_phone, v_email)');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'padrão 2/4 não encontrado (INSERT presale_customers)';
  END IF;

  v_def := v_new;
  v_new := replace(v_def, 'checkout_email, checkout_trainer, items', 'checkout_email, items');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'padrão 3/4 não encontrado (colunas de presale_orders)';
  END IF;

  v_def := v_new;
  v_new := replace(v_def, 'v_email, v_trainer, v_items', 'v_email, v_items');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'padrão 4/4 não encontrado (VALUES de presale_orders)';
  END IF;

  EXECUTE v_new;

  ---------------------------------------------------------------- 2
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'eon_private' AND p.proname = 'claim_public_coupon';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'claim_public_coupon não encontrada';
  END IF;

  v_new := replace(v_def,
    'WHERE coupon_id = v_coupon.id',
    'WHERE public.coupon_uses.coupon_id = v_coupon.id');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'padrão do cupom não encontrado (WHERE coupon_id)';
  END IF;

  EXECUTE v_new;
END
$do$;
