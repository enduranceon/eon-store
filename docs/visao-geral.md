# Visão geral (`/admin`)

Página de entrada do sistema desde a fase 1 (2026-11-09). Responde "como está a EON hoje?"
com quatro números, uma faixa de atenção, o caixa do ano e a composição por modalidade.
É **somente leitura**: abrir, atualizar ou trocar de ano/mês não grava contrato, pagamento,
mensagem nem estorno, e não chama o Asaas.

## Entrada e navegação

- Login leva a `/admin`. `/hoje` é só um redirecionamento para `/admin` (a antiga fila de
  ações do dia foi substituída pela faixa "Atenção" + as telas de destino).
- O menu tem uma única entrada, "Visão geral" (`src/lib/navigation.js`, área `overview`).
- `Dashboard.jsx` e `Today.jsx` foram removidos. Indicadores (`/assessoria/indicadores`),
  Cobranças (`/financeiro`) e Fluxo de caixa (`/financeiro/fluxo-caixa`) continuam sendo as
  telas de análise e de ação.

## Blocos e fontes

Cada bloco carrega e falha sozinho (`src/components/overview/overview-loader.js`). Um erro
em um bloco mostra "Não foi possível carregar" com "Tentar novamente" **e nunca vira zero**.

| Bloco | Fonte | Regra |
| --- | --- | --- |
| Alunos ativos | `buildContractLifecycleRows` (mesma classificação de Indicadores/Analytics) | Pessoas **únicas** com ao menos um contrato com `lifecycle.counts.active` hoje. Licença conta como ativo; rascunho, agendado e cancelado não. |
| MRR contratado | `getContractMonthlyValue` via `lifecycle.counts.mrr` | Soma do valor mensal equivalente (desconto, prazo vendido e pro rata já aplicados). É valor contratado, **não** dinheiro recebido. |
| Recebido líquido no mês | `GET /financial/movements` (`isActual=true`) | Soma do `net_amount` dos recebimentos realizados do mês corrente, todas as áreas, taxa já abatida. Parcial até a data da consulta. |
| Vencido em aberto | mesma fonte e mesmo filtro de Cobranças (`loadOpenSalesOrders` + `selectActiveOpenOrders`) | Saldo aberto com `due_date` **anterior a hoje** (dia local). "Vence hoje" e "sem vencimento" são contados à parte e não entram. Contrato com carnê é substituído por uma linha por parcela sem registro. |
| Atenção | contagens independentes | Ordem fixa e máximo de 4 grupos: cobranças vencidas, estornos pendentes (`refund_status = pending`), renovações para cobrar (`renewal_stage = charge_pending`), contatos a fazer (Central, `state = to_do`). |
| Caixa do ano | `GET /financial/movements` do ano (limite 20000) + primeiro movimento realizado | Ver abaixo. |
| Modalidades hoje | plano do contrato (`assessment_modalities`) | Composição de hoje, não histórica. |

`src/lib/open-sales-source.js` é a fonte compartilhada de vendas em aberto: Cobranças e a
Visão geral usam o mesmo código, então o "Vencido" daqui bate com a lista de lá.

## Caixa do ano

`resultado do mês = recebido líquido + ajustes positivos − saídas realizadas`

- Entram só movimentos **realizados** (recebimento, estorno, despesa, repasse, ajuste de
  repasse), pela data efetiva do movimento. "A receber" nunca entra.
- A taxa já está abatida no recebido líquido e não é descontada de novo.
- Ajuste positivo que não é recebimento aparece em linha própria (nunca é escondido para
  forçar duas barras); ajuste negativo entra nas saídas.
- Mesmo `movement_id` conta uma vez; ids diferentes com mesmo valor e data são operações
  distintas e permanecem.
- Estados do mês: `realizado` (mês fechado com histórico), `parcial` (mês corrente, até a
  data da consulta), `futuro` e `sem histórico` (mês que termina antes do primeiro movimento
  realizado conhecido). Futuro e sem histórico ficam **sem barra e sem valor**: ausência
  não é zero.
- A tela diz que o resultado é "diferença entre movimentos registrados; não é saldo
  bancário". Se a composição não fechar com o resultado, o mês mostra um alerta.
- Se a consulta do ano atingir o limite de 20000 movimentos, a tela avisa que o ano pode
  estar incompleto.
- Escolher ano ou mês no painel **não altera** os quatro cartões, que são sempre de hoje.
- "Ver movimentações" lista os movimentos do mês com a mesma regra de data e leva a
  `/financeiro/fluxo-caixa`.

## Modalidades

- A modalidade vem do plano de cada contrato ativo.
- Quem tem contratos ativos em mais de uma modalidade aparece em **cada** uma, e o total da
  EON conta a pessoa uma vez. Quando a soma das linhas passa do total, a tela explica isso.
- O MRR é atribuído por contrato, sem dupla contagem.
- Ticket = MRR da modalidade ÷ pessoas com MRR nela.
- Contrato sem modalidade no plano fica em "Sem modalidade".

## Diferenças que podem existir (e são legítimas)

- **MRR × recebido**: MRR é o contratado por mês; recebido é caixa realizado, inclui planos
  de outros prazos, renovações, loja, eventos e pré-venda.
- **Alunos ativos × movimentos de Assessoria**: o número é uma foto de hoje; o movimento é
  entrada e saída de contratos no período. A reconciliação base × movimentos (fase 2) ainda
  não foi construída.
- **Vencido × tela de Cobranças**: devem bater (mesma fonte). Diferença indica bug.
- **Caixa × saldo bancário**: não há saldo bancário aqui.
- Parcelas em aberto de carnê ainda não entram em "a receber" do fluxo de caixa; o Vencido
  as inclui por parcela.

## O que não é feito aqui

Não envia mensagem, não registra pagamento, não estorna, não chama o Asaas. Os links levam
às telas onde cada ação é feita.

## Fora da fase 1

- Fase 2: aba Alunos com reconciliação entre a base e os movimentos.
- Fase 3: filtro histórico por modalidade, só se os dados sustentarem.

## Testes

`npm run test:unit` cobre os helpers puros: `overview-cash`, `overview-students`,
`overview-overdue` e a navegação (`navigation.test.js`). Validação visual: renderizada com
dados fictícios em 360, 768 e 1280 px (sem rolagem horizontal, estados de carregamento e
erro por bloco). Os números dos mockups do PDF de especificação são fictícios.
