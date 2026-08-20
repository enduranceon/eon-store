-- Cancelar um pedido zerava a cobranca mas deixava a entrega como estava, entao
-- o pedido cancelado continuava aparecendo como "aguardando separacao" nas
-- listas operacionais. Em 18/ago/2026 havia 7 pedidos nesse estado.
--
-- Passa a cancelar tambem a entrega, no MESMO UPDATE que ja muda o pagamento
-- (importante: os gatilhos de estoque e de Asaas reagem a payment_status, entao
-- nao ha disparo extra nem devolucao de estoque em dobro).
--
-- Guarda: pedido ja ENTREGUE mantem a entrega como esta. A peca saiu de verdade;
-- apagar esse fato falsearia o historico. Cancelar o pagamento de um pedido
-- entregue continua possivel, so nao mexe na entrega.
--
-- Metodo: parte da definicao vigente no banco e aplica substituicoes pontuais,
-- abortando se alguma nao casar, para nunca aplicar correcao parcial.

DO $do$
DECLARE
  v_def TEXT;
  v_new TEXT;
  v_hits INT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'complete_order_cancellation';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'complete_order_cancellation nao encontrada';
  END IF;

  -- 1) cancela a entrega nos dois UPDATE (presale e stock)
  v_hits := (length(v_def) - length(replace(v_def,
    E'    SET payment_status = ''cancelled'',\n        cancellation_reason = v_operation.reason,', '')))
    / length(E'    SET payment_status = ''cancelled'',\n        cancellation_reason = v_operation.reason,');

  IF v_hits <> 2 THEN
    RAISE EXCEPTION 'esperava 2 blocos de UPDATE, encontrei %', v_hits;
  END IF;

  v_new := replace(v_def,
    E'    SET payment_status = ''cancelled'',\n        cancellation_reason = v_operation.reason,',
    E'    SET payment_status = ''cancelled'',\n'
    || E'        delivery_status = CASE\n'
    || E'          WHEN COALESCE(delivery_status, '''') = ''delivered'' THEN delivery_status\n'
    || E'          ELSE ''cancelled''\n'
    || E'        END,\n'
    || E'        cancellation_reason = v_operation.reason,');

  -- 2) registra na auditoria se a entrega foi cancelada junto
  v_def := v_new;
  v_new := replace(v_def,
    E'      ''stock_restocked'', v_stock_restocked\n    ),',
    E'      ''stock_restocked'', v_stock_restocked,\n'
    || E'      ''delivery_cancelled'', COALESCE(v_delivery_status, '''') <> ''delivered''\n    ),');

  IF v_new = v_def THEN
    RAISE EXCEPTION 'padrao do evento de auditoria nao encontrado';
  END IF;

  EXECUTE v_new;
END
$do$;;
