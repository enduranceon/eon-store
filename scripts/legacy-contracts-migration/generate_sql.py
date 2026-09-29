#!/usr/bin/env python3
"""Gera o SQL de migração de contratos legados a partir da planilha de
migração (abas Contratos/Créditos/Planos).

Consome apenas linhas válidas da aba Contratos (Nome completo + ID Migração
preenchidos) e usa exclusivamente as RPCs administrativas já existentes no
sistema (create_assessment_contract_from_admin, api_record_manual_payment,
start_assessment_contract_leave, finish_assessment_contract_leave).

Cliente: procura por CPF, depois e-mail, depois WhatsApp — nunca só por nome.
Cadastro encontrado só tem os campos vazios completados; mais de um cadastro
compatível, ou um cadastro com outro CPF, interrompe a execução.

Uso:
  python3 generate_sql.py <planilha.xlsx> <actor_id_uuid>
      [--batch 2] [--exclude MIG-015,...] [--replace MIG-006=ASS-000206,...]

Saída: SQL em stdout, sem BEGIN/COMMIT (quem chama decide a transação,
ver build_run_sql.py): cria a função temporária pg_temp.mig_customer, um
bloco DO por contrato, e apaga a função no fim.
"""
import argparse
import json
import pandas as pd

PIX_MANUAL = "6af03a9b-56d8-42ce-b89f-615443fd8de5"
CREDIT_CARD_1X = "5063e08d-09c4-4e86-a47e-5e88dc22d0a1"
PAYMENT_METHODS = {
    ("Boleto", 1): "c3fd3088-07f2-4fa5-b834-2b6d9b14e117",
    ("PIX", 1): PIX_MANUAL,
    ("Boleto - PIX", 1): PIX_MANUAL,
    ("Cartão", 1): CREDIT_CARD_1X,
    ("Cartão recorrência", 1): CREDIT_CARD_1X,
    ("Cartão", 6): "317166a0-8d2b-4bcc-92cc-c5da84f6b857",
}
GENDERS = {"Feminino": "feminino", "Masculino": "masculino"}


def sql_str(value):
    if value is None:
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


def sql_date(value):
    if value is None or pd.isna(value):
        return "null"
    return f"'{pd.Timestamp(value).strftime('%Y-%m-%d')}'::date"


def sql_num(value):
    if value is None or pd.isna(value):
        return "0"
    return f"{float(value):.2f}"


def only_digits(value):
    if value is None or pd.isna(value):
        return None
    return "".join(ch for ch in str(value) if ch.isdigit()) or None


def br_phone(value):
    """Devolve (número nacional com DDD, E.164) de um celular/fixo brasileiro."""
    digits = only_digits(value)
    if not digits:
        return None, None
    if digits.startswith("55") and len(digits) in (12, 13):
        digits = digits[2:]
    if len(digits) not in (10, 11):
        raise ValueError(f"WhatsApp inválido: {value!r}")
    return digits, "+55" + digits


def load_data(path):
    contratos = pd.read_excel(path, sheet_name="Contratos")
    contratos = contratos[
        contratos["Nome completo"].notna() & contratos["ID Migração"].notna()
    ].copy()
    creditos = pd.read_excel(path, sheet_name="Créditos")
    creditos = creditos[creditos["ID Migração"].notna()].copy()
    return contratos, creditos


def build_installments_json(creditos_contrato):
    installments = []
    for _, r in creditos_contrato.sort_values("Parcela").iterrows():
        credit_date = pd.Timestamp(r["Data crédito"]).strftime("%Y-%m-%d")
        installments.append({
            "number": int(r["Parcela"]),
            "due_date": credit_date,
            "credit_date": credit_date,
            "value": round(float(r["Valor crédito"]), 2),
        })
    return installments


CUSTOMER_HELPER = r"""
CREATE FUNCTION pg_temp.mig_customer(
  p_mig text, p_name text, p_cpf text, p_email text, p_phone text,
  p_birth date, p_gender text, p_zip text
) RETURNS uuid LANGUAGE plpgsql AS $mig_customer$
DECLARE
  v_ids uuid[];
  v_id uuid;
  v_phone_national text := substr(p_phone, 4);
BEGIN
  -- CPF, depois e-mail, depois WhatsApp (nunca só por nome)
  SELECT array_agg(id) INTO v_ids FROM public.presale_customers
  WHERE regexp_replace(coalesce(cpf, ''), '\D', '', 'g') = p_cpf;
  IF coalesce(array_length(v_ids, 1), 0) = 0 AND p_email IS NOT NULL THEN
    SELECT array_agg(id) INTO v_ids FROM public.presale_customers
    WHERE lower(btrim(email)) = p_email;
  END IF;
  IF coalesce(array_length(v_ids, 1), 0) = 0 AND p_phone IS NOT NULL THEN
    SELECT array_agg(id) INTO v_ids FROM public.presale_customers
    WHERE regexp_replace(coalesce(whatsapp, ''), '\D', '', 'g')
          IN (v_phone_national, '55' || v_phone_national);
  END IF;
  IF coalesce(array_length(v_ids, 1), 0) > 1 THEN
    RAISE EXCEPTION '%: mais de um cadastro compatível (%), revisar manualmente', p_mig, v_ids;
  END IF;
  v_id := v_ids[1];

  IF v_id IS NULL THEN
    INSERT INTO public.presale_customers (
      full_name, cpf, whatsapp, email, birth_date, gender, address_zip
    ) VALUES (p_name, p_cpf, p_phone, p_email, p_birth, p_gender, p_zip)
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.presale_customers
    WHERE id = v_id
      AND nullif(regexp_replace(coalesce(cpf, ''), '\D', '', 'g'), '') IS NOT NULL
      AND regexp_replace(cpf, '\D', '', 'g') <> p_cpf
  ) THEN
    RAISE EXCEPTION '%: o cadastro encontrado tem outro CPF, revisar manualmente', p_mig;
  END IF;
  -- Completa só o que estiver vazio; nada existente é sobrescrito
  UPDATE public.presale_customers SET
    cpf = CASE WHEN nullif(btrim(cpf), '') IS NULL THEN p_cpf ELSE cpf END,
    email = CASE WHEN nullif(btrim(email), '') IS NULL THEN p_email ELSE email END,
    whatsapp = CASE WHEN nullif(btrim(whatsapp), '') IS NULL THEN p_phone ELSE whatsapp END,
    birth_date = coalesce(birth_date, p_birth),
    gender = CASE WHEN nullif(btrim(gender), '') IS NULL THEN p_gender ELSE gender END,
    address_zip = CASE WHEN nullif(btrim(address_zip), '') IS NULL THEN p_zip ELSE address_zip END
  WHERE id = v_id
    AND (nullif(btrim(cpf), '') IS NULL
      OR (nullif(btrim(email), '') IS NULL AND p_email IS NOT NULL)
      OR (nullif(btrim(whatsapp), '') IS NULL AND p_phone IS NOT NULL)
      OR (birth_date IS NULL AND p_birth IS NOT NULL)
      OR (nullif(btrim(gender), '') IS NULL AND p_gender IS NOT NULL)
      OR (nullif(btrim(address_zip), '') IS NULL AND p_zip IS NOT NULL));
  RETURN v_id;
END $mig_customer$;
"""

CUSTOMER_HELPER_DROP = (
    "DROP FUNCTION pg_temp.mig_customer(text, text, text, text, text, date, text, text);"
)


def customer_lines(mig, row):
    full_name = str(row["Nome completo"]).strip()
    cpf = only_digits(row["CPF"])
    if not cpf or len(cpf) != 11:
        raise ValueError(f"{mig}: CPF inválido")
    email = row.get("E-mail")
    email = str(email).strip().lower() if pd.notna(email) else None
    _, phone_e164 = br_phone(row.get("WhatsApp"))
    gender = GENDERS.get(row.get("Gênero"))
    birth = sql_date(row.get("Nascimento"))
    zip_code = only_digits(row.get("CEP"))
    return [
        "  -- 1) Cliente (pg_temp.mig_customer: CPF, e-mail, WhatsApp; só completa vazios)",
        f"  v_customer_id := pg_temp.mig_customer({sql_str(mig)}, {sql_str(full_name)}, "
        f"{sql_str(cpf)}, {sql_str(email)}, {sql_str(phone_e164)}, {birth}, "
        f"{sql_str(gender)}, {sql_str(zip_code)});",
    ]


def gen_block(row, creditos_contrato, actor_id, key_prefix, batch, replacement_number):
    mig = row["ID Migração"]
    full_name = str(row["Nome completo"]).strip()
    enrollment_fee = row.get("Taxa de adesão", 0) or 0
    desconto = row.get("Desconto automático", 0) or 0
    acrescimo = row.get("Acréscimo manual", 0) or 0
    total_pago = row["Total pago esperado"]

    n_installments = int(creditos_contrato["Parcela"].max())
    pm_id = PAYMENT_METHODS.get((row["Forma pagamento"], n_installments))
    if pm_id is None:
        raise ValueError(
            f"{mig}: sem mapeamento de forma de pagamento para "
            f"({row['Forma pagamento']!r}, {n_installments} parcelas)"
        )

    installments_json = build_installments_json(creditos_contrato)
    installments_total = round(sum(i["value"] for i in installments_json), 2)
    if abs(installments_total - round(float(total_pago), 2)) > 0.01:
        raise ValueError(
            f"{mig}: soma das parcelas ({installments_total}) difere do "
            f"total pago esperado ({total_pago})"
        )
    if float(desconto) > 0 and float(acrescimo) > 0:
        raise ValueError(f"{mig}: desconto e acréscimo ao mesmo tempo")

    leave_start = row.get("Início licença")
    leave_end = row.get("Fim licença")
    has_leave = pd.notna(leave_start)
    leave_is_open = has_leave and pd.isna(leave_end)

    idem_key = f"{key_prefix}-{mig.lower()}"
    note = (
        f"Migração de contrato legado (lote {batch}, {mig})"
        if batch else f"Migração de contrato legado ({mig})"
    )
    discount_reason = "Migração de contrato legado" if float(desconto) > 0 else None
    tag = f"{key_prefix}_{mig}".replace("-", "_")

    lines = [
        f"-- {'=' * 70}",
        f"-- {mig}: {full_name}",
        f"-- {'=' * 70}",
        f"DO ${tag}$",
        "DECLARE",
        "  v_customer_id uuid;",
        "  v_replacement_id uuid;",
        "  v_result jsonb;",
        "  v_contract_id uuid;",
        "  v_updated_at timestamptz;",
        "  v_leave_result jsonb;",
        "  v_leave_id uuid;",
        "BEGIN",
    ]
    lines += customer_lines(mig, row)

    if replacement_number:
        lines += [
            "",
            f"  -- Substitui a venda descartada {replacement_number} do mesmo aluno",
            "  SELECT id INTO v_replacement_id FROM public.assessment_contracts",
            f"  WHERE contract_number = {sql_str(replacement_number)};",
            "  IF v_replacement_id IS NULL THEN",
            f"    RAISE EXCEPTION '{mig}: contrato {replacement_number} não encontrado';",
            "  END IF;",
        ]

    lines += [
        "",
        "  -- 2) Contrato (idempotente via assessment_contract_creation_operations)",
        "  SELECT public.create_assessment_contract_from_admin(",
        "    v_customer_id,",
        f"    {sql_str(row['Coach ID'])}::uuid,",
        f"    {sql_str(row['Plan ID'])}::uuid,",
        f"    {sql_date(row['Início contrato'])},",
        f"    {n_installments},",
        f"    {sql_num(enrollment_fee)},",
        f"    {sql_num(desconto)},",
        f"    {sql_str(discount_reason)},",
        "    false,",
        f"    {sql_str(note)},",
        "    v_replacement_id,",
        f"    {sql_str(idem_key)},",
        f"    {sql_str(actor_id)}::uuid",
        "  ) INTO v_result;",
        "  v_contract_id := (v_result->'contract'->>'id')::uuid;",
    ]

    if float(acrescimo) > 0:
        lines += [
            "",
            "  -- 3) Acréscimo legado: o snapshot guarda o valor histórico total",
            "  --    (manual_fee é taxa de gateway e é zerado pelo pagamento manual)",
            "  UPDATE public.assessment_contracts",
            "  SET plan_snapshot = jsonb_set(plan_snapshot, '{price_total}', "
            f"to_jsonb({sql_num(row['Valor contrato'])}::numeric))",
            "  WHERE id = v_contract_id;",
        ]

    lines += [
        "",
        "  -- 4) Pagamento manual com as parcelas exatas da planilha",
        "  SELECT public.api_record_manual_payment(",
        "    'contract',",
        "    v_contract_id,",
        f"    {sql_str(pm_id)}::uuid,",
        f"    {sql_date(row['Data pagamento'])},",
        f"    {sql_num(total_pago)},",
        f"    {sql_str(json.dumps(installments_json))}::jsonb,",
        f"    {sql_str(actor_id)}::uuid",
        "  ) INTO v_result;",
    ]

    if has_leave:
        lines += [
            "",
            "  -- 5) Licença",
            "  SELECT updated_at INTO v_updated_at FROM public.assessment_contracts WHERE id = v_contract_id;",
            "  SELECT public.start_assessment_contract_leave(",
            "    v_contract_id,",
            f"    {sql_date(leave_start)},",
            f"    {'null' if leave_is_open else sql_date(leave_end)},",
            f"    {sql_str('Migração de contrato legado')},",
            "    v_updated_at,",
            f"    {sql_str(actor_id)}::uuid",
            "  ) INTO v_leave_result;",
            "  v_leave_id := (v_leave_result->'leave'->>'id')::uuid;",
        ]
        if not leave_is_open:
            lines += [
                "  SELECT updated_at INTO v_updated_at FROM public.assessment_contracts WHERE id = v_contract_id;",
                "  PERFORM public.finish_assessment_contract_leave(",
                f"    v_contract_id, v_leave_id, v_updated_at, {sql_str(actor_id)}::uuid",
                "  );",
            ]

    lines += [
        "",
        "  -- 6) O fim do contrato é o da planilha (o gatilho de licença pode ter estendido)",
        "  UPDATE public.assessment_contracts",
        f"  SET end_date = {sql_date(row['Fim contrato'])}, original_end_date = {sql_date(row['Fim contrato'])}",
        "  WHERE id = v_contract_id;",
        f"END ${tag}$;",
        "",
    ]
    return "\n".join(lines)


def parse_pairs(raw):
    pairs = {}
    for item in filter(None, (x.strip() for x in raw.split(","))):
        mig, number = item.split("=")
        pairs[mig.strip()] = number.strip()
    return pairs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("xlsx_path")
    parser.add_argument("actor_id")
    parser.add_argument("--batch", type=int, default=None,
                        help="número do lote (a partir do 2); o lote 1 não usa")
    parser.add_argument("--exclude", default="", help="MIG ids separados por vírgula")
    parser.add_argument("--replace", default="",
                        help="MIG=ASS-XXXXXX: venda descartada que o contrato substitui")
    args = parser.parse_args()

    key_prefix = f"legacy-migration-b{args.batch}" if args.batch else "legacy-migration"
    exclude = {x.strip() for x in args.exclude.split(",") if x.strip()}
    replacements = parse_pairs(args.replace)
    contratos, creditos = load_data(args.xlsx_path)
    contratos = contratos[~contratos["ID Migração"].isin(exclude)]

    blocks = []
    for _, row in contratos.iterrows():
        mig = row["ID Migração"]
        blocks.append(gen_block(
            row, creditos[creditos["ID Migração"] == mig], args.actor_id,
            key_prefix, args.batch, replacements.get(mig),
        ))

    print(f"-- Migração de {len(blocks)} contratos legados — chave {key_prefix}-mig-*")
    print(f"-- Excluídos: {sorted(exclude) or 'nenhum'} | Substituições: {replacements or 'nenhuma'}")
    print(CUSTOMER_HELPER.strip())
    print()
    print("\n".join(blocks))
    print(CUSTOMER_HELPER_DROP)


if __name__ == "__main__":
    main()
