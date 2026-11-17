-- Trocar o link da cobrança externa de um pedido (loja ou pré-venda) volta a
-- mensagem para "não enviada": a pessoa ainda tem o link antigo e não recebeu o
-- novo. Antes o pedido seguia como "cobrança enviada" e a Central não oferecia
-- o reenvio (caso EST-000089, 2026-11-11: link enviado por WhatsApp às 15:18,
-- trocado às 15:22, e a pessoa ficou com o link de uma fatura cancelada).
--
-- É a mesma regra que o contrato tem desde 20261027150000. Mesmo link com outro
-- vencimento continua como enviado: a pessoa já tem o link certo.

DO $do$
DECLARE
  v_def text;
  v_anchor constant text := $a$        external_invoice_number = v_clean_invoice,
$a$;
BEGIN
  v_def := pg_get_functiondef(
    'public.save_order_external_charge(text,uuid,text,date,text,text,timestamptz,uuid)'::regprocedure);
  -- Uma vez no UPDATE da pré-venda e outra no da loja.
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 2 THEN
    RAISE EXCEPTION 'save_order_external_charge: atualização do pedido não encontrada duas vezes';
  END IF;
  v_def := replace(v_def, v_anchor, $a$        external_invoice_number = v_clean_invoice,
        payment_message_sent_at = CASE
          WHEN nullif(v_external_link, '') IS DISTINCT FROM p_external_link THEN NULL
          ELSE o.payment_message_sent_at END,
$a$);
  EXECUTE v_def;
END
$do$;
