#!/usr/bin/env python3
"""Gera o SQL de migração de contratos legados a partir da planilha
EON_Store_Migracao_Contratos_atualizado.xlsx (abas Contratos/Créditos/Planos).

Consome apenas linhas válidas da aba Contratos (Nome completo + ID Migração
preenchidos) e usa exclusivamente as RPCs administrativas já existentes no
sistema (create_assessment_contract_from_admin, api_record_manual_payment,
start_assessment_contract_leave, finish_assessment_contract_leave) — nunca
insert direto nas tabelas de negócio.

Uso:
  python3 generate_sql.py <planilha.xlsx> <actor_id_uuid> [--exclude MIG-015,...]

Saída: SQL completo em stdout, um bloco DO $$ por contrato, sem BEGIN/COMMIT
(quem chama decide a transação — ver README.md).
"""
import sys
import argparse
import json
import pandas as pd

ACTOR_ID_PLACEHOLDER = None  # setado via argv

PAYMENT_METHODS = {
    ("Boleto", 1): "c3fd3088-07f2-4fa5-b834-2b6d9b14e117",
    ("Cartão", 1): "5063e08d-09c4-4e86-a47e-5e88dc22d0a1",
    ("Cartão recorrência", 1): "5063e08d-09c4-4e86-a47e-5e88dc22d0a1",
    ("Cartão", 6): "317166a0-8d2b-4bcc-92cc-c5da84f6b857",
}


def sql_str(value):
    if value is None:
        return "null"
    escaped = str(value).replace("'", "''")
    return f"'{escaped}'"


def sql_date(value):
    if value is None or pd.isna(value):
        return "null"
    return f"'{pd.Timestamp(value).strftime('%Y-%m-%d')}'::date"


def sql_num(value):
    if value is None or pd.isna(value):
        return "0"
    return f"{float(value):.2f}"


def load_data(path):
    contratos = pd.read_excel(path, sheet_name="Contratos")
    contratos = contratos[
        contratos["Nome completo"].notna() & contratos["ID Migração"].notna()
    ].copy()
    creditos = pd.read_excel(path, sheet_name="Créditos")
    creditos = creditos[creditos["ID Migração"].notna()].copy()
    return contratos, creditos


def build_installments_json(creditos_contrato):
    rows = creditos_contrato.sort_values("Parcela")
    installments = []
    for _, r in rows.iterrows():
        credit_date = pd.Timestamp(r["Data crédito"]).strftime("%Y-%m-%d")
        installments.append({
            "number": int(r["Parcela"]),
            "due_date": credit_date,
            "credit_date": credit_date,
            "value": round(float(r["Valor crédito"]), 2),
        })
    return installments


def gen_block(row, creditos_contrato, actor_id):
    mig = row["ID Migração"]
    full_name = str(row["Nome completo"]).strip()
    cpf_digits = "".join(ch for ch in str(row["CPF"]) if ch.isdigit())
    whatsapp = row.get("WhatsApp")
    whatsapp_digits = (
        "".join(ch for ch in str(whatsapp) if ch.isdigit())
        if pd.notna(whatsapp) else None
    )
    email = row.get("E-mail")
    email_val = str(email).strip().lower() if pd.notna(email) else None
    gender_map = {"Feminino": "feminino", "Masculino": "masculino"}
    gender = gender_map.get(row.get("Gênero"), None)
    birth_date = row.get("Nascimento")
    zip_code = row.get("CEP")
    zip_digits = (
        "".join(ch for ch in str(zip_code) if ch.isdigit())
        if pd.notna(zip_code) else None
    )

    coach_id = row["Coach ID"]
    plan_id = row["Plan ID"]
    start_date = row["Início contrato"]
    end_date = row["Fim contrato"]
    enrollment_fee = row.get("Taxa de adesão", 0) or 0
    desconto = row.get("Desconto automático", 0) or 0
    acrescimo = row.get("Acréscimo manual", 0) or 0
    valor_contrato = row["Valor contrato"]
    total_pago = row["Total pago esperado"]
    payment_date = row["Data pagamento"]
    forma_pagamento = row["Forma pagamento"]

    n_installments = int(creditos_contrato["Parcela"].max())
    pm_id = PAYMENT_METHODS.get((forma_pagamento, n_installments))
    if pm_id is None:
        raise ValueError(
            f"{mig}: sem mapeamento de forma de pagamento para "
            f"({forma_pagamento!r}, {n_installments} parcelas)"
        )

    installments_json = build_installments_json(creditos_contrato)
    installments_total = round(sum(i["value"] for i in installments_json), 2)
    if abs(installments_total - round(float(total_pago), 2)) > 0.01:
        raise ValueError(
            f"{mig}: soma das parcelas ({installments_total}) difere do "
            f"total pago esperado ({total_pago})"
        )

    em_licenca = bool(row.get("Em licença"))
    leave_start = row.get("Início licença")
    leave_end = row.get("Fim licença")
    has_leave = pd.notna(leave_start)
    leave_is_open = has_leave and pd.isna(leave_end)

    idem_key = f"legacy-migration-{mig.lower()}"
    discount_reason = "Migração de contrato legado" if float(desconto) > 0 else None

    lines = []
    lines.append(f"-- {'=' * 70}")
    lines.append(f"-- {mig}: {full_name}")
    lines.append(f"-- {'=' * 70}")
    lines.append(f"DO ${mig.replace('-', '_')}$")
    lines.append("DECLARE")
    lines.append("  v_customer_id uuid;")
    lines.append("  v_result jsonb;")
    lines.append("  v_contract_id uuid;")
    lines.append("  v_updated_at timestamptz;")
    lines.append("  v_leave_result jsonb;")
    lines.append("  v_leave_id uuid;")
    lines.append("BEGIN")
    lines.append(f"  RAISE NOTICE '--- {mig}: {full_name} ---';")
    lines.append("")
    lines.append("  -- 1) Cliente: localizar por CPF, senão criar")
    lines.append("  SELECT id INTO v_customer_id")
    lines.append("  FROM public.presale_customers")
    lines.append(
        f"  WHERE regexp_replace(cpf, '\\D', '', 'g') = {sql_str(cpf_digits)};"
    )
    lines.append("")
    lines.append("  IF v_customer_id IS NULL THEN")
    lines.append("    INSERT INTO public.presale_customers (")
    lines.append("      full_name, cpf, whatsapp, email, birth_date, gender, address_zip")
    lines.append("    ) VALUES (")
    lines.append(f"      {sql_str(full_name)}, {sql_str(cpf_digits)},")
    lines.append(f"      {sql_str(whatsapp_digits)}, {sql_str(email_val)},")
    lines.append(f"      {sql_date(birth_date)}, {sql_str(gender)}, {sql_str(zip_digits)}")
    lines.append("    )")
    lines.append("    RETURNING id INTO v_customer_id;")
    lines.append(f"    RAISE NOTICE '{mig}: cliente criado %', v_customer_id;")
    lines.append("  ELSE")
    lines.append(f"    RAISE NOTICE '{mig}: cliente já existente %', v_customer_id;")
    lines.append("  END IF;")
    lines.append("")
    lines.append("  -- 2) Contrato (idempotente nativamente via assessment_contract_creation_operations)")
    lines.append("  SELECT public.create_assessment_contract_from_admin(")
    lines.append("    v_customer_id,")
    lines.append(f"    {sql_str(coach_id)}::uuid,")
    lines.append(f"    {sql_str(plan_id)}::uuid,")
    lines.append(f"    {sql_date(start_date)},")
    lines.append(f"    {n_installments},")
    lines.append(f"    {sql_num(enrollment_fee)},")
    lines.append(f"    {sql_num(desconto)},")
    lines.append(f"    {sql_str(discount_reason)},")
    lines.append("    false,")
    lines.append(f"    {sql_str('Migração de contrato legado (' + mig + ')')},")
    lines.append("    null,")
    lines.append(f"    {sql_str(idem_key)},")
    lines.append(f"    {sql_str(actor_id)}::uuid")
    lines.append("  ) INTO v_result;")
    lines.append("  v_contract_id := (v_result->'contract'->>'id')::uuid;")
    lines.append(
        f"  RAISE NOTICE '{mig}: contrato % (id=%)', "
        "v_result->'contract'->>'contract_number', v_contract_id;"
    )

    if float(acrescimo) > 0:
        lines.append("")
        lines.append("  -- 3) Acréscimo legado: snapshot já nasce com o valor histórico total")
        lines.append("  --    (manual_fee tem outro significado no sistema — taxa de gateway —")
        lines.append("  --    e é zerado pela RPC de pagamento manual; não pode ser usado aqui)")
        lines.append("  UPDATE public.assessment_contracts")
        lines.append(
            "  SET plan_snapshot = jsonb_set(plan_snapshot, '{price_total}', "
            f"to_jsonb({sql_num(valor_contrato)}::numeric))"
        )
        lines.append("  WHERE id = v_contract_id;")

    lines.append("")
    lines.append("  -- 4) Pagamento manual (parcelas exatas da planilha, sem projeção automática)")
    lines.append("  SELECT public.api_record_manual_payment(")
    lines.append("    'contract',")
    lines.append("    v_contract_id,")
    lines.append(f"    {sql_str(pm_id)}::uuid,")
    lines.append(f"    {sql_date(payment_date)},")
    lines.append(f"    {sql_num(total_pago)},")
    lines.append(f"    {sql_str(json.dumps(installments_json))}::jsonb,")
    lines.append(f"    {sql_str(actor_id)}::uuid")
    lines.append("  ) INTO v_result;")
    lines.append(f"  RAISE NOTICE '{mig}: pagamento %', v_result;")

    if has_leave:
        lines.append("")
        lines.append("  -- 5) Licença")
        lines.append("  SELECT updated_at INTO v_updated_at FROM public.assessment_contracts WHERE id = v_contract_id;")
        lines.append("  SELECT public.start_assessment_contract_leave(")
        lines.append("    v_contract_id,")
        lines.append(f"    {sql_date(leave_start)},")
        lines.append(f"    {sql_date(leave_end) if not leave_is_open else 'null'},")
        lines.append(f"    {sql_str('Migração de contrato legado')},")
        lines.append("    v_updated_at,")
        lines.append(f"    {sql_str(actor_id)}::uuid")
        lines.append("  ) INTO v_leave_result;")
        lines.append("  v_leave_id := (v_leave_result->'leave'->>'id')::uuid;")
        lines.append(f"  RAISE NOTICE '{mig}: licença iniciada %', v_leave_id;")

        if not leave_is_open:
            lines.append("")
            lines.append("  -- Licença histórica já concluída: fecha imediatamente")
            lines.append("  SELECT updated_at INTO v_updated_at FROM public.assessment_contracts WHERE id = v_contract_id;")
            lines.append("  PERFORM public.finish_assessment_contract_leave(")
            lines.append("    v_contract_id, v_leave_id, v_updated_at,")
            lines.append(f"    {sql_str(actor_id)}::uuid")
            lines.append("  );")
            lines.append(f"  RAISE NOTICE '{mig}: licença finalizada %', v_leave_id;")

    lines.append("")
    lines.append("  -- 6) Conferência final: end_date deve bater exatamente com a planilha")
    lines.append("  --    (o trigger de licença pode ter estendido de forma diferente do")
    lines.append("  --    valor final já calculado/curado na planilha; a planilha manda)")
    lines.append("  UPDATE public.assessment_contracts")
    lines.append(f"  SET end_date = {sql_date(end_date)}, original_end_date = {sql_date(end_date)}")
    lines.append("  WHERE id = v_contract_id;")
    lines.append("")
    lines.append(f"  RAISE NOTICE '{mig}: CONCLUÍDO contract_id=%', v_contract_id;")
    lines.append(f"END ${mig.replace('-', '_')}$;")
    lines.append("")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("xlsx_path")
    parser.add_argument("actor_id")
    parser.add_argument("--exclude", default="", help="MIG ids separados por vírgula")
    args = parser.parse_args()

    exclude = {x.strip() for x in args.exclude.split(",") if x.strip()}
    contratos, creditos = load_data(args.xlsx_path)
    contratos = contratos[~contratos["ID Migração"].isin(exclude)]

    blocks = []
    for _, row in contratos.iterrows():
        mig = row["ID Migração"]
        creditos_contrato = creditos[creditos["ID Migração"] == mig]
        blocks.append(gen_block(row, creditos_contrato, args.actor_id))

    print(f"-- Migração de {len(blocks)} contratos legados (Stone -> EON Store)")
    print(f"-- Excluídos: {sorted(exclude) or 'nenhum'}")
    print(f"-- Gerado por scripts/legacy-contracts-migration/generate_sql.py")
    print()
    print("\n".join(blocks))


if __name__ == "__main__":
    main()
