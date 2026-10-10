# Planos de cada coach no site

Cada coach pode ter, por modalidade, um plano escolhido para cada duração
(mensal, trimestral, semestral...). Isso vale só para o site. A venda interna
(Prospects, contrato, renovação) continua podendo usar qualquer plano.

## Onde configurar

Assessoria > Coaches > editar o coach > "Planos que vende no site" (aparece com
"Exibir no site" marcado). Para cada modalidade do coach e cada duração:

- **Planos gerais do site**: quando nenhuma duração da modalidade tem plano
  escolhido, o site mostra os planos gerais (`available_online`), como antes.
- **Um plano**: o site mostra para este coach só os planos escolhidos na
  modalidade. Duração sem plano fica fora ("Não vende esta duração no site").

O banco só aceita plano ativo, da mesma modalidade e da mesma duração
(`assessment_coach_site_plans`, uma linha por coach, modalidade e duração).

## O que o site recebe

`GET https://bsiljrrodgtmtdilnuxr.supabase.co/functions/v1/public-assessment-prospect`
continua devolvendo `plans`, `modalities` e `coaches` como antes. Cada coach
ganhou `site_plans`:

```json
{
  "id": "…", "name": "…", "modality_ids": ["…"],
  "site_plans": [
    {
      "modality_id": "…",
      "period_months": 1,
      "plan_id": "…",
      "plan": {
        "id": "…", "name": "Corrida - Essencial - Mensal", "period": "mensal",
        "period_months": 1, "price_monthly": 210, "price_total": 210,
        "enrollment_fee": 0, "max_installments": 1, "modality_id": "…"
      }
    }
  ]
}
```

Regra no site, para o coach e a modalidade escolhidos:

1. Se `coach.site_plans` tem itens dessa modalidade, mostrar só esses planos
   (um por duração). O "A partir de" do card do coach é o menor
   `price_monthly` entre eles.
2. Se não tem, usar `plans` da modalidade, como hoje.

O plano de `site_plans` pode não estar em `plans` (por exemplo, um plano
"Essencial" que não aparece para os outros coaches): use o objeto `plan` que
vem junto.

## O que o cadastro aceita

O `POST` do mesmo endereço aceita o plano se ele for da modalidade do coach e,
ou for um plano geral do site (`available_online`), ou estiver em
`site_plans` desse coach. Plano escolhido para outro coach é recusado
(`INVALID_PLAN`).
