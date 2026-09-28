#!/usr/bin/env python3
"""Gera a conferência pós-migração (planilha x banco) dos contratos legados.

A consulta gerada devolve uma linha por divergência (tipo = 'divergência')
seguida do resumo agregado (tipo = 'resumo'). Nenhuma linha de divergência
significa que banco e planilha batem em todos os campos conferidos.

Uso:
  python3 verify_sql.py <planilha.xlsx> [--exclude MIG-015,...]
"""
import argparse
import pandas as pd

METHOD_CODE = {
    ("Boleto", 1): "boleto",
    ("Cartão", 1): "credit_card",
    ("Cartão recorrência", 1): "credit_card",
    ("Cartão", 6): "card_6x",
}

TEMPLATE = r"""
WITH expected (mig_key, cpf, start_date, end_date, total, n_inst, enrollment_fee,
               manual_discount, snapshot_price, payment_date, method_code,
               status, leave_start, leave_end) AS (
  VALUES
__CONTRACTS__
),
expected_inst (mig_key, num, credit_date, amount) AS (
  VALUES
__INSTALLMENTS__
),
actual AS (
  SELECT aco.operation_key AS mig_key, ac.*,
         pc.full_name AS customer_name,
         regexp_replace(pc.cpf, '\D', '', 'g') AS cpf_digits,
         coalesce(to_jsonb(pc)->>'created_at', to_jsonb(pc)->>'created_date')::timestamptz
           AS customer_created_at
  FROM public.assessment_contract_creation_operations aco
  JOIN public.assessment_contracts ac ON ac.id = (aco.result->'contract'->>'id')::uuid
  JOIN public.presale_customers pc ON pc.id = ac.customer_id
  WHERE aco.operation_key LIKE 'legacy-migration-%'
),
contract_checks AS (
  SELECT e.mig_key, c.check_name, c.expected, c.actual
  FROM expected e
  LEFT JOIN actual a ON a.mig_key = e.mig_key
  CROSS JOIN LATERAL (VALUES
    ('contrato existe', 'sim', CASE WHEN a.id IS NULL THEN 'não' ELSE 'sim' END, a.id IS NOT NULL),
    ('cpf do cliente', e.cpf, a.cpf_digits, a.cpf_digits = e.cpf),
    ('início', e.start_date::text, a.start_date::text, a.start_date = e.start_date),
    ('fim', e.end_date::text, a.end_date::text, a.end_date = e.end_date),
    ('fim original', e.end_date::text, a.original_end_date::text, a.original_end_date = e.end_date),
    ('status', e.status, a.status, a.status = e.status),
    ('situação do pagamento', 'paid', a.payment_status, a.payment_status = 'paid'),
    ('pagamento manual', 'true', a.manual_payment::text, a.manual_payment),
    ('data do pagamento', e.payment_date::text, a.payment_date::text, a.payment_date = e.payment_date),
    ('forma de pagamento', e.method_code, a.payment_method, a.payment_method = e.method_code),
    ('parcelas no contrato', e.n_inst::text, a.installments::text, a.installments = e.n_inst),
    ('matrícula', e.enrollment_fee::text, a.enrollment_fee::text,
      abs(a.enrollment_fee - e.enrollment_fee) < 0.005),
    ('desconto', e.manual_discount::text, coalesce(a.manual_discount, 0)::text,
      abs(coalesce(a.manual_discount, 0) - e.manual_discount) < 0.005),
    ('preço no snapshot', e.snapshot_price::text, a.plan_snapshot->>'price_total',
      abs((a.plan_snapshot->>'price_total')::numeric - e.snapshot_price) < 0.005),
    ('renovação automática', 'false', a.auto_renewal::text, NOT a.auto_renewal),
    ('desconto recorrente', 'false', a.discount_recurring::text, NOT a.discount_recurring),
    ('cobrança Asaas', '(nenhuma)', coalesce(a.asaas_charge_id, '(nenhuma)'), a.asaas_charge_id IS NULL),
    ('mensagem de cobrança', '(nenhuma)', coalesce(a.payment_message_sent_at::text, '(nenhuma)'),
      a.payment_message_sent_at IS NULL),
    ('evento de criação', 'sim',
      CASE WHEN EXISTS (SELECT 1 FROM public.assessment_contract_event ev
                        WHERE ev.contract_id = a.id AND ev.event_type = 'created')
           THEN 'sim' ELSE 'não' END,
      EXISTS (SELECT 1 FROM public.assessment_contract_event ev
              WHERE ev.contract_id = a.id AND ev.event_type = 'created')),
    ('evento de pagamento manual', 'sim',
      CASE WHEN EXISTS (SELECT 1 FROM public.assessment_contract_event ev
                        WHERE ev.contract_id = a.id AND ev.event_type = 'manual_payment_recorded')
           THEN 'sim' ELSE 'não' END,
      EXISTS (SELECT 1 FROM public.assessment_contract_event ev
              WHERE ev.contract_id = a.id AND ev.event_type = 'manual_payment_recorded'))
  ) AS c(check_name, expected, actual, ok)
  WHERE c.ok IS NOT TRUE
),
inst_actual AS (
  SELECT a.mig_key, ap.installment_number AS num, ap.credit_date, ap.due_date,
         ap.payment_date, ap.value AS amount, ap.source, ap.status
  FROM actual a
  JOIN public.asaas_payments ap ON ap.order_id = a.id AND ap.order_type = 'contract'
),
inst_checks AS (
  SELECT coalesce(e.mig_key, i.mig_key) AS mig_key,
         'parcela ' || coalesce(e.num, i.num)::text AS check_name,
         coalesce(e.credit_date::text || ' R$ ' || e.amount::text, '(não prevista)') AS expected,
         coalesce(i.credit_date::text || ' R$ ' || i.amount::text || ' ' || i.source || '/' || i.status,
                  '(ausente)') AS actual
  FROM expected_inst e
  FULL JOIN inst_actual i ON i.mig_key = e.mig_key AND i.num = e.num
  LEFT JOIN expected ec ON ec.mig_key = coalesce(e.mig_key, i.mig_key)
  WHERE e.mig_key IS NULL OR i.mig_key IS NULL
     OR i.credit_date <> e.credit_date
     OR i.due_date <> e.credit_date
     OR i.payment_date <> ec.payment_date
     OR abs(i.amount - e.amount) >= 0.005
     OR i.source <> 'manual'
     OR i.status <> 'CONFIRMED'
),
leave_checks AS (
  SELECT e.mig_key, 'licença' AS check_name,
         CASE WHEN e.leave_start IS NULL THEN '(nenhuma)'
              ELSE e.leave_start::text || ' -> ' || coalesce(e.leave_end::text, 'aberta') || ' ' ||
                   CASE WHEN e.leave_end IS NULL THEN 'active' ELSE 'finished' END
         END AS expected,
         coalesce((
           SELECT string_agg(l.start_date::text || ' -> ' || coalesce(l.end_date::text, 'aberta')
                             || ' ' || l.status, ', ')
           FROM public.assessment_leaves l WHERE l.contract_id = a.id
         ), '(nenhuma)') AS actual
  FROM expected e
  JOIN actual a ON a.mig_key = e.mig_key
),
extra_contracts AS (
  SELECT a.mig_key, 'contrato fora da planilha' AS check_name,
         '(nenhum)' AS expected, a.contract_number AS actual
  FROM actual a
  WHERE NOT EXISTS (SELECT 1 FROM expected e WHERE e.mig_key = a.mig_key)
),
duplicate_cpfs AS (
  SELECT e.mig_key, 'clientes com este CPF' AS check_name, '1' AS expected,
         count(pc.id)::text AS actual
  FROM expected e
  LEFT JOIN public.presale_customers pc ON regexp_replace(pc.cpf, '\D', '', 'g') = e.cpf
  GROUP BY e.mig_key
  HAVING count(pc.id) <> 1
),
mismatches AS (
  SELECT mig_key, check_name, expected, actual FROM contract_checks
  UNION ALL SELECT mig_key, check_name, expected, actual FROM inst_checks
  UNION ALL SELECT mig_key, check_name, expected, actual FROM leave_checks
            WHERE expected IS DISTINCT FROM actual
  UNION ALL SELECT mig_key, check_name, expected, actual FROM extra_contracts
  UNION ALL SELECT mig_key, check_name, expected, actual FROM duplicate_cpfs
),
summary (ord, item, expected, actual) AS (
  SELECT 1, 'contratos migrados',
         (SELECT count(*) FROM expected)::text, (SELECT count(*) FROM actual)::text
  UNION ALL
  SELECT 2, 'clientes criados pela migração', '-',
         (SELECT count(*) FROM actual WHERE customer_created_at >= created_at)::text
  UNION ALL
  SELECT 3, 'clientes que já existiam', '-',
         (SELECT count(*) || ': ' || coalesce(string_agg(customer_name, ', ' ORDER BY mig_key), '')
          FROM actual WHERE customer_created_at < created_at)
  UNION ALL
  SELECT 4, 'parcelas registradas',
         (SELECT count(*) FROM expected_inst)::text, (SELECT count(*) FROM inst_actual)::text
  UNION ALL
  SELECT 5, 'valor total pago (R$)',
         (SELECT sum(total) FROM expected)::text, (SELECT sum(amount) FROM inst_actual)::text
  UNION ALL
  SELECT 6, 'licenças',
         (SELECT count(*) FROM expected WHERE leave_start IS NOT NULL)::text,
         (SELECT count(*) FROM public.assessment_leaves l JOIN actual a ON a.id = l.contract_id)::text
  UNION ALL
  SELECT 7, 'contratos ativos',
         (SELECT count(*) FROM expected WHERE status = 'active')::text,
         (SELECT count(*) FROM actual WHERE status = 'active')::text
  UNION ALL
  SELECT 8, 'contratos em licença',
         (SELECT count(*) FROM expected WHERE status = 'on_leave')::text,
         (SELECT count(*) FROM actual WHERE status = 'on_leave')::text
)
SELECT 'divergência' AS tipo, mig_key AS item, check_name AS detalhe,
       expected AS esperado, actual AS no_banco
FROM mismatches
UNION ALL
SELECT 'resumo', item, '', expected, actual FROM (SELECT * FROM summary ORDER BY ord) s;
"""


def sql_date(value):
    if value is None or pd.isna(value):
        return "null::date"
    return f"'{pd.Timestamp(value).strftime('%Y-%m-%d')}'::date"


def sql_num(value):
    if value is None or pd.isna(value):
        return "0.00::numeric"
    return f"{float(value):.2f}::numeric"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("xlsx_path")
    parser.add_argument("--exclude", default="", help="MIG ids separados por vírgula")
    args = parser.parse_args()
    exclude = {x.strip() for x in args.exclude.split(",") if x.strip()}

    contratos = pd.read_excel(args.xlsx_path, sheet_name="Contratos")
    contratos = contratos[
        contratos["Nome completo"].notna()
        & contratos["ID Migração"].notna()
        & ~contratos["ID Migração"].isin(exclude)
    ]
    creditos = pd.read_excel(args.xlsx_path, sheet_name="Créditos")
    creditos = creditos[
        creditos["ID Migração"].notna() & ~creditos["ID Migração"].isin(exclude)
    ]

    contract_rows = []
    for _, r in contratos.iterrows():
        mig = r["ID Migração"]
        n_inst = int(creditos[creditos["ID Migração"] == mig]["Parcela"].max())
        acrescimo = float(r.get("Acréscimo manual") or 0)
        snapshot = r["Valor contrato"] if acrescimo > 0 else r["Preço tabela"]
        leave_open = pd.notna(r.get("Início licença")) and pd.isna(r.get("Fim licença"))
        cpf = "".join(ch for ch in str(r["CPF"]) if ch.isdigit())
        contract_rows.append(
            f"    ('legacy-migration-{mig.lower()}', '{cpf}', {sql_date(r['Início contrato'])}, "
            f"{sql_date(r['Fim contrato'])}, {sql_num(r['Total pago esperado'])}, {n_inst}, "
            f"{sql_num(r.get('Taxa de adesão'))}, {sql_num(r.get('Desconto automático'))}, "
            f"{sql_num(snapshot)}, {sql_date(r['Data pagamento'])}, "
            f"'{METHOD_CODE[(r['Forma pagamento'], n_inst)]}', "
            f"'{'on_leave' if leave_open else 'active'}', "
            f"{sql_date(r.get('Início licença'))}, {sql_date(r.get('Fim licença'))})"
        )

    inst_rows = [
        f"    ('legacy-migration-{r['ID Migração'].lower()}', {int(r['Parcela'])}, "
        f"{sql_date(r['Data crédito'])}, {sql_num(r['Valor crédito'])})"
        for _, r in creditos.iterrows()
    ]

    print(
        TEMPLATE.replace("__CONTRACTS__", ",\n".join(contract_rows))
        .replace("__INSTALLMENTS__", ",\n".join(inst_rows))
        .strip()
    )


if __name__ == "__main__":
    main()
