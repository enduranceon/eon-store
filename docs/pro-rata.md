# Pro rata do plano mensal

Desde 27/10/2026. Serve para o aluno novo que entra no meio do mês e passa a
ter o ciclo sempre no mesmo dia, o dia da assinatura no Asaas.

## Como funciona

- Na ficha do contrato, cartão **Pro rata**: escolher o **dia do ciclo**, de 1
  a 28, porque esses dias existem em todo mês.
- O primeiro contrato passa a terminar no próximo dia do ciclo depois do
  início. O valor desse período é o **mensal ÷ 30 × dias**.
  - Exemplo: início em 28/10, ciclo no dia 7, de 28/10 a 06/11 são 10 dias.
    R$ 210 ÷ 30 × 10 = R$ 70,00.
- A renovação seguinte nasce **cheia**, do dia do ciclo ao dia do ciclo (07/11
  a 07/12), com o valor mensal do plano. Se o contrato tiver a automática
  ligada e a assinatura do Asaas começar no dia do ciclo, o link de cada mês
  vem sozinho.
- **Matrícula:** se houver, entra na primeira cobrança, junto do proporcional.
- **Repasse do coach:** sai proporcional sem nada especial, porque o repasse é
  calculado por dia de contrato.
- **Link já enviado:** o pro rata não mexe nele. Depois de aplicar, a tela abre
  a edição da cobrança para registrar o link novo com o valor proporcional.
  O link antigo é cancelado no Asaas por quem opera; o sistema não altera nada
  lá.
- **Mensagem do link novo:** trocar o link volta a mensagem para "não enviada"
  e a tela já abre a mensagem de adesão para copiar. Ela diz o proporcional
  ("10 dias (R$ 210,00 ÷ 30 × 10)") e o mensal cheio a partir do dia do ciclo.
  Na Central, a cobrança diz "(ASS-…, proporcional de 28/10 a 06/11)" no
  `{referente}` (migração `20261027150000_charge_link_change_message.sql`).
- **Mudar o dia ou desfazer:** dá para fazer enquanto o contrato não tem
  pagamento nem renovação criada. Desfazer volta ao mês cheio a partir do
  início.

## Regras

- **Só para plano mensal.** Trimestral, semestral e anual são recusados.
- **Só antes do pagamento:**
  - sem pagamento manual e sem parcelas registradas;
  - sem cobrança da integração Asaas;
  - sem renovação criada, sem mudança de plano e sem licença.
- O dia do ciclo não pode ser o próprio dia do início, porque aí não há pro
  rata.

## Onde fica no banco

- **Função:** `public.apply_assessment_contract_prorata(contract_id,
  cycle_day, expected_updated_at, actor_id)`. Ela recebe `cycle_day` NULL para
  desfazer e só o backend chama.
- **API:** `POST /orders/contract/:id/prorata` com
  `{ "cycle_day": 7 | null, "expected_updated_at": "..." }`.
- **Contrato:**
  - `plan_snapshot.price_total` vira o valor proporcional;
  - `plan_snapshot.prorata` guarda `cycle_day`, `days`, `full_price_total`,
    `start_date` e `end_date`;
  - `end_date` e `original_end_date` passam a ser o dia do ciclo.

  Por isso a cobrança, a conferência no Asaas e as mensagens já usam o valor
  proporcional.
- **Renovação:** o processamento diário monta o contrato com
  `eon_private.plan_snapshot_without_prorata` e volta ao valor cheio.
- **MRR e conferência de assinaturas:** contam o mensal cheio.
- **Link da fatura da assinatura:** depois de um pro rata, a fatura esperada
  vence no início da renovação, o dia do ciclo.
- **Histórico do contrato:** eventos `prorata_applied` e `prorata_removed`.
- **Migração:** `20261027120000_monthly_prorata.sql`.
