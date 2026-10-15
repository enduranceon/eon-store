BEGIN;
SET LOCAL lock_timeout = '5s';

-- Mensagens de cobrança de pedidos e inscrições mais humanas (pedido do
-- usuário em 15/10/2026): {referente} deixa de mostrar o número interno
-- (EST-/PED-/INS-) e, num pedido de um item só, já diz o item, então
-- {itens_bloco} só lista quando há mais de um item (antes o item aparecia
-- duas vezes). Contrato continua igual. Mesma regra em
-- src/lib/billing-message.js.

CREATE OR REPLACE FUNCTION eon_private.communication_template_context(p_context jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_due date;
  v_end date;
  v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_type text;
  v_balance numeric;
  v_link text := NULLIF(p_context->>'payment_link', '');
  v_pix text := NULLIF(p_context->>'pix_copy', '');
  v_name text := COALESCE(NULLIF(btrim(p_context->>'person_name'),''),'Cliente');
  v_item jsonb;
  v_items text := '';
  v_first_item text;
  v_single_item text;
  v_item_name text;
  v_item_count integer:=0;
  v_quantity integer;
  v_ref text := NULLIF(p_context->>'reference', '');
  v_plan_end date;
  v_plan_name text := NULLIF(p_context->>'plan_name', '');
  v_overdue integer;
  v_about text;
BEGIN
  v_due := NULLIF(p_context->>'due_date', '')::date;
  v_end := NULLIF(p_context->>'end_date', '')::date;
  v_balance := NULLIF(p_context->>'balance', '')::numeric;
  -- Na renovação, o fim que importa é o do plano atual (contrato anterior).
  IF p_context->>'source_type' = 'contract'
     AND NULLIF(p_context->>'parent_contract_id', '') IS NOT NULL THEN
    SELECT parent.end_date INTO v_plan_end
    FROM public.assessment_contracts parent
    WHERE parent.id = (p_context->>'parent_contract_id')::uuid;
  END IF;
  v_plan_end := COALESCE(v_plan_end, v_end);
  v_type := CASE p_context->>'source_type'
    WHEN 'contract' THEN 'contrato' WHEN 'event' THEN 'inscricao'
    ELSE 'pedido' END;
  IF jsonb_typeof(p_context->'items')='array' THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_context->'items') LOOP
      IF COALESCE(v_item->>'cancelled','false')='true' THEN CONTINUE; END IF;
      v_item_name:=COALESCE(NULLIF(v_item->>'product_name',''),
        NULLIF(v_item->>'name',''),NULLIF(v_item->>'description',''));
      IF v_item_name IS NULL THEN CONTINUE; END IF;
      v_item_count:=v_item_count+1;
      v_first_item:=COALESCE(v_first_item,v_item_name);
      v_quantity:=CASE WHEN COALESCE(v_item->>'quantity','') ~ '^[0-9]{1,4}$'
        THEN GREATEST(1,(v_item->>'quantity')::integer) ELSE 1 END;
      IF v_item_count=1 THEN
        v_single_item:=v_item_name || CASE WHEN v_quantity>1 THEN ' x' || v_quantity ELSE '' END;
      END IF;
      v_items:=v_items || CASE WHEN v_items='' THEN '' ELSE E'\n' END ||
        '- ' || v_item_name || ' x' || v_quantity;
    END LOOP;
  END IF;
  -- Cobrança vencida: há quantos dias e a que se refere.
  v_overdue := v_today - v_due;
  v_first_item := CASE WHEN v_item_count>1 THEN v_first_item||' +'||(v_item_count-1)
    ELSE v_first_item END;
  -- Pedido ou inscrição com um item só: o item diz o que é. Com mais de um, a
  -- lista vai em {itens_bloco}. O número interno (EST-/PED-/INS-) não aparece.
  IF v_item_count<>1 THEN v_single_item:=NULL; END IF;
  v_about := CASE p_context->>'source_type'
    WHEN 'contract' THEN CASE
      WHEN NULLIF(p_context->>'plan_name','') IS NOT NULL
        THEN 'referente ao seu plano ' || (p_context->>'plan_name')
          || COALESCE(' (' || v_ref || ')', '')
      ELSE 'referente ao seu contrato' || COALESCE(' ' || v_ref, '') END
    WHEN 'event' THEN 'da sua inscrição' || COALESCE(' (' || v_single_item || ')', '')
    ELSE 'do seu pedido' || COALESCE(' (' || v_single_item || ')', '') END;
  RETURN jsonb_build_object(
    'nome', split_part(v_name,' ',1),
    'nome_completo', v_name,
    'tipo', v_type,
    'numero', COALESCE(NULLIF(p_context->>'reference', ''), 'sem numero'),
    'valor', CASE WHEN v_balance IS NULL THEN 'saldo a conferir'
      ELSE 'R$ ' || replace(to_char(v_balance, 'FM999999999990.00'), '.', ',') END,
    'vencimento_texto', CASE WHEN v_due IS NULL THEN ''
      ELSE ', com vencimento em *' || to_char(v_due, 'DD/MM/YYYY') || '*' END,
    'vencimento', CASE WHEN v_due IS NULL THEN '' ELSE to_char(v_due, 'DD/MM/YYYY') END,
    'vencimento_atraso', CASE WHEN v_due IS NULL THEN ''
      ELSE ' em ' || to_char(v_due, 'DD/MM/YYYY') END,
    'pix_bloco', CASE WHEN v_pix IS NULL THEN ''
      ELSE 'PIX Copia e Cola:' || E'\n' || v_pix || E'\n\n' END,
    'pix_copia_cola', COALESCE(v_pix,''),
    'link_bloco', CASE WHEN v_link IS NULL THEN ''
      ELSE 'Link de pagamento:' || E'\n' || v_link || E'\n\n' END,
    'link_pagamento', COALESCE(v_link,''),
    'item', COALESCE(v_first_item,''),
    'dias_atraso', CASE WHEN v_overdue IS NULL OR v_overdue <= 0 THEN ''
      WHEN v_overdue = 1 THEN '1 dia' ELSE v_overdue || ' dias' END,
    'referente', v_about,
    'itens', v_items,
    'itens_bloco', CASE WHEN v_item_count>1
      THEN 'Itens:' || E'\n' || v_items || E'\n\n' ELSE '' END,
    'plano', COALESCE(NULLIF(p_context->>'plan_name', ''), 'seu plano'),
    'data_fim', CASE WHEN v_end IS NULL THEN '' ELSE to_char(v_end, 'DD/MM/YYYY') END,
    'fim_plano', CASE WHEN v_plan_end IS NULL THEN '' ELSE to_char(v_plan_end, 'DD/MM') END,
    'dias', CASE WHEN v_end IS NULL THEN '' ELSE (v_end-v_today)::text END,
    'aviso_vencimento', CASE WHEN v_plan_end IS NULL
      THEN 'a data de vencimento do seu plano precisa ser confirmada'
      ELSE 'seu plano' || COALESCE(' ' || v_plan_name, '')
        || CASE WHEN v_plan_end >= v_today THEN ' vence em ' ELSE ' venceu em ' END
        || to_char(v_plan_end, 'DD/MM') END,
    'modalidade', COALESCE(NULLIF(p_context->>'modality_name',''),'a confirmar'),
    'coach', COALESCE(NULLIF(p_context->>'coach_name',''),'a definir'),
    'comunidade', COALESCE(NULLIF(p_context->>'community_link',''),
      '(link da comunidade não configurado)')
  );
END;
$function$;

REVOKE ALL ON FUNCTION eon_private.communication_template_context(jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION eon_private.communication_template_context(jsonb)
  TO service_role;

COMMIT;
