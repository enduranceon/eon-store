# Fluxos de mensagens

Conversas que o sistema puxa com o aluno pela Central de Comunicação. Cada
fluxo registra quem entra, os passos, o que trava e as decisões em aberto. As
mensagens são enviadas manualmente pelo WhatsApp; o sistema sugere o texto e
registra o envio quando o operador confirma.

Os quatro fluxos estão abaixo: onboarding, proposta, cobrança e renovação.

## 1. Onboarding

Regra de entrada: `eon_private.communication_onboarding_eligible` (migrações
`20261007170000_onboarding_first_membership_only.sql`,
`20261007190000_onboarding_returning_students.sql` e
`20261007210000_onboarding_three_steps.sql`). O caso de onboarding é
aberto pelo gatilho do contrato e reavaliado a cada mudança relevante; quando a
regra deixa de valer, o caso fecha como `source_resolved`.

```mermaid
flowchart TD
  A([Contrato da assessoria pago<br/>ativo, agendado ou em licença]) --> B{Renovação ligada<br/>ao contrato anterior?}
  B -- sim --> X[Sem onboarding]
  B -- não --> C{Marcado como aluno<br/>ativo no prospect?}
  C -- sim --> X
  C -- não --> D{Pago há mais de 30 dias?}
  D -- sim --> X
  D -- não --> E{Já teve algum contrato antes?<br/>pela data de início}
  E -- não, aluno novo --> F[Abre a boas-vindas na Central]
  E -- sim --> K{O último terminou há<br/>mais de 30 dias?}
  K -- não, renovação --> X
  K -- sim, retorno --> F
  F --> G[Passo 1: boas-vindas<br/>no dia do pagamento]
  G -- enviada --> H[Dia 5 da boas-vindas]
  H --> I[Passo 2: check-in]
  I -- enviado --> L[Dia 20 da boas-vindas]
  L --> M[Passo 3: feedback]
  M -- enviado --> J([Onboarding concluído])
```

- Entram no mesmo onboarding o **aluno novo** (nunca teve contrato real na
  assessoria) e o **ex-aluno que volta** depois de mais de 30 dias sem contrato.
  Contrato real é ativo, vencido, em licença, encerrado, ou cancelado/agendado
  com pagamento. Rascunhos, prospects e contratos anulados não contam.
- Renovação, inclusive atrasada até 30 dias, não entra. O fim do contrato é
  exclusivo (`end_date`); no cancelado, o dia do cancelamento ainda conta.
- A ordem entre contratos vem da data de início, não da data de cadastro.
  Histórico importado depois (Tecnofit) e contratos de alunos migrados contam
  como contrato anterior.
- A boas-vindas só vale para pagamento dos últimos 30 dias (data do pagamento
  ou, sem ela, data de início). Depois dela, o check-in (dia 5) e o feedback
  (dia 20, pelo menos 7 dias depois do check-in) seguem por até 30 dias a partir
  da boas-vindas. O onboarding termina quando o feedback é registrado.
- Onboarding iniciado no painel anterior e com check-in registrado lá (evento
  com `source` diferente de `communication_case`) terminou no check-in e não
  volta para o feedback.
- Envio manual, sem travas: a Central mostra o texto para copiar, o atalho do
  WhatsApp e o botão “Registrar que enviei”. No onboarding, WhatsApp ausente,
  link da comunidade ausente ou passo antes da data não impedem o registro; só
  impedem etapa já concluída, contrato fora do onboarding (inclusive pagamento
  reaberto) ou modelo ausente. Cobrança e renovação mantêm as conferências.
- Textos: modelos `onboarding-welcome`, `onboarding-checkin-5d` e
  `onboarding-feedback-20d`, editáveis em Comunicação → Modelos e regras.

### Decisões em aberto

Decidido em 07/10/2026:

- Ex-aluno que volta recebe o mesmo onboarding do aluno novo. O limite de 30
  dias sem contrato para contar como retorno é o padrão adotado e pode ser
  ajustado.
- Três passos: boas-vindas no dia do pagamento, check-in no dia 5 e feedback no
  dia 20 (saber se deu certo, se está conseguindo e se ficou dúvida).
- Sem travas no envio: copiar o texto e registrar que enviou.

1. Mensagem apresentando o novo treinador quando a renovação troca de treinador.
2. Prazo da boas-vindas: hoje 30 dias depois do pagamento; sugestão inicial de 7.

## 2. Proposta

Do cadastro do prospect ao pagamento, no quadro de Prospects. Migração
`20261008150000_prospect_contact_flow.sql` (etapas `awaiting_reply` e
`clarifying`, datas do relógio e `register_assessment_prospect_contact`);
próximo passo e textos em `src/lib/assessment-prospect-flow.js`.

```mermaid
flowchart TD
  A([Prospect novo<br/>site ou cadastro manual]) --> B[1: Primeiro contato, sem link]
  B --> C{O que a pessoa respondeu?<br/>você marca no card}
  C -- tem dúvidas --> D[Tirando dúvidas]
  D -- decidiu --> C
  C -- quer seguir --> E[Preparar proposta<br/>plano, parcelas, link e vencimento]
  C -- não quer agora --> X[Não convertido, com motivo]
  C -- sem resposta --> F[Lembrete no dia 2]
  F -- continua sem resposta --> G[Encerramento no dia 5]
  G --> Y[Não convertido: não respondeu]
  E --> H[2: Proposta com link]
  H --> I{Pagou?}
  I -- sim --> J([Vira aluno e abre a boas-vindas])
  I -- não --> K[3: Lembrete no dia seguinte ao vencimento]
  K --> L[4: Encerramento 5 dias depois do vencimento<br/>link ativo por mais 2 dias]
  L -- pagou no prazo --> J
  L -- prazo final --> M[Arquivar: cancelar o link no Asaas]
  M --> Z[Não convertido: não respondeu]
```

- Colunas: Novos → Aguardando resposta → Tirando dúvidas → Proposta pronta →
  Link enviado → Convertidos / Não convertidos. O card mostra o próximo passo e
  quando ele vence; o filtro e o contador "Para hoje" juntam o que já venceu.
- Primeiro contato: para cadastros do site. Cadastro manual e aluno atual vão
  direto para "Preparar proposta" (o atalho também vale para qualquer card).
  Em Novos, o card mostra há quanto tempo o cadastro chegou.
- Respostas: "Quer seguir" abre a proposta; "Tem dúvidas" leva a Tirando
  dúvidas; "Conversamos hoje" reinicia o relógio; "Não quer agora" e "Número
  não funciona" são motivos de Não convertido (`invalid_contact`, e também
  `other_service` para quem queria outro serviço).
- Relógio sem link (Aguardando resposta e Tirando dúvidas): lembrete 2 dias
  depois do último contato registrado; encerramento no dia 5, pelo menos 3 dias
  depois do lembrete. Registrar o encerramento arquiva como "Não respondeu".
- Relógio com link: lembrete de pagamento (o reenvio do link) no dia seguinte
  ao vencimento; encerramento 5 dias depois do vencimento, pelo menos 3 dias
  depois do lembrete. O encerramento deixa o link ativo por mais 2 dias; no
  prazo final o card pede para arquivar e, antes, cancelar o link no Asaas.
  Reenviar o link depois do encerramento retira o prazo.
- Antes do lembrete de pagamento e do encerramento com link, a janela consulta a
  fatura no Asaas (só leitura, a mesma do botão de Cobranças). Se já foi paga,
  mostra "Já pagou no Asaas" e o pagamento é registrado pela conferência, com
  confirmação. A coluna Link enviado tem "Conferir no Asaas" para todos de uma
  vez. Pagamento registrado converte o prospect e abre a boas-vindas.
- Envio manual e sem travas de data: copiar o texto (ou abrir o WhatsApp) e
  "Registrar que enviei". A janela avisa a data do último contato para conferir a
  conversa antes de cobrar.
- Textos ainda fixos no código (`assessment-prospect-flow.js` e a mensagem da
  proposta em `Prospects.jsx`).

### Decisões

Decidido em 08/10/2026:

- Primeiro contato sem link, perguntando se quer seguir ou se tem dúvidas.
- Sem resposta: lembrete no dia 2 e encerramento no dia 5, arquivando como "Não
  respondeu". O lembrete traz ajuda (explicação, áudio ou ligação), não "viu
  minha mensagem?".
- Com link: lembrete no dia seguinte ao vencimento e encerramento 5 dias depois,
  com o link ativo por mais 2 dias antes de arquivar.
- Conferência no Asaas no próprio card, com um clique para registrar e a
  boas-vindas abrindo em seguida.

1. Textos editáveis em Comunicação → Modelos e regras, como os do onboarding.
2. Retomar um prospect arquivado em um clique (hoje: "Novo prospect").

## 3. Cobrança

Toda venda com saldo em aberto, na Central de Comunicação. Regra em
`eon_private.communication_case_suggestion` (cobrança) e
`eon_private.ensure_communication_case`; ajustes na migração
`20261008190000_billing_flow.sql`.

```mermaid
flowchart TD
  A([Venda com saldo em aberto<br/>assessoria, renovação, loja, pré-venda, evento]) --> P{Prospect em rascunho?}
  P -- sim --> X[Fica no quadro de Prospects]
  P -- não --> L{Cobrança cadastrada?<br/>link ou PIX}
  L -- não --> C0[Falta cadastrar a cobrança<br/>Ver origem]
  C0 --> L
  L -- sim --> B[1: Cobrança com link]
  B --> D{Trimestral ou semestral<br/>e lembrete ligado?}
  D -- sim --> E[2: Lembrete na véspera do vencimento]
  D -- não --> F
  E --> G[3: Vencida: todo dia a partir do 3º dia<br/>há quantos dias venceu e a que se refere]
  G --> G
  G -. resposta registrada .-> R[Pausa: vai pagar dia X volta nesse dia;<br/>já pagou ou contestou vai para conferência]
  B -. pagamento registrado .-> Z([Cobrança encerrada])
```

- Entram as vendas com saldo em aberto: assessoria, renovação, loja,
  pré-venda e eventos. Prospect em rascunho fica no quadro de Prospects, com o
  lembrete e o encerramento da proposta. Renovação ainda na conversa do Pebinha
  fica no fluxo de renovação.
- Sem cobrança cadastrada (nem link nem PIX), o caso aparece como "Falta
  cadastrar a cobrança" e aponta para a venda ("Ver origem").
- Passos: cobrança com link no cadastro; lembrete na véspera do vencimento para
  planos trimestrais e semestrais (política em Comunicação → Modelos e regras,
  ligada desde 08/10/2026); vencida, todo dia a partir do 3º dia, até a
  pessoa responder.
- Os textos da primeira cobrança e dos lembretes de véspera e do dia também
  dizem a que se refere a cobrança (`{referente}`), com acentos e no mesmo tom
  das outras mensagens (migração `20261008230000_billing_texts_pre_due.sql`).
- A mensagem de atraso é uma só e diz há quantos dias a cobrança venceu
  (`{dias_atraso}`) e a que se refere (`{referente}`: "referente ao seu plano
  Corrida - Trimestral (ASS-…)", "ao seu pedido PED-… (item)" ou "à sua
  inscrição …"). Como a contagem é pelo calendário, um dia sem envio não
  desarruma a fila: no dia seguinte a mensagem já sai com o número certo.
- Resposta registrada pausa a régua: "Vai pagar" com data volta nesse dia;
  "Informou que já pagou" vai para a conferência de pagamento; "Contestou" e
  "Precisa de atendimento" vão para revisão.
- "Desconsiderar mensagem e pular para a próxima": o passo da vez fica feito
  sem envio e sem mexer na venda (`message_skipped`). A cobrança vencida volta
  no dia seguinte.
- Sem travar a régua: se a cobrança com link ou o lembrete da véspera não forem
  enviados nem registrados, depois do vencimento a régua de atraso começa
  sozinha (as mensagens de atraso também levam o link). O lembrete da véspera
  não se repete no dia do vencimento.
- Antes de cobrar, a janela consulta a fatura no Asaas (só leitura). Se já foi
  paga, mostra "Já pagou no Asaas" e registra o pagamento pela conferência,
  com confirmação; o caso fecha sozinho.
- Diferente do onboarding, a cobrança mantém as conferências de data, link e
  WhatsApp no "Registrar que enviei".
- Textos: modelos `billing-*` em Comunicação → Modelos e regras. A vencida usa
  `billing-charge-overdue`; os modelos antigos de 5, 7, 8, 10 e 11 dias ficaram
  desativados (o histórico de versões guarda os textos).

### Decisões

Decidido em 08/10/2026:

- Cobrança vencida todo dia a partir do 3º dia, até a pessoa dar uma resposta,
  com uma mensagem só que diz há quantos dias venceu e a que se refere (no
  lugar de 3, 5 e 7 dias e diário depois do 7º).
- Lembrete na véspera para trimestral e semestral, com "Desconsiderar mensagem".
- Se nada for enviado nem registrado, a régua de atraso segue depois do
  vencimento.

1. O que acontece com o treino de quem não paga a renovação (fica para depois).

## 4. Renovação

Quadro de Renovações e Central de Comunicação. Régua em
`eon_private.assessment_renewal_contact_plan` (e
`assessment_renewal_contact_plan_for`, que lê o contrato); o passo enviado
fica em `assessment_contracts.renewal_contact_step` e é gravado só por
`transition_assessment_renewal_stage`. Migração
`20261008220000_renewal_contact_flow.sql`.

```mermaid
flowchart TD
  A([Plano perto do fim<br/>entra no quadro 10 dias antes]) --> M{Mensal automática?}
  M -- sim --> W[Aguardando pagamento<br/>5 dias antes, sem Pebinha]
  M -- não --> P[1: Pebinha<br/>10 dias antes, 5 opções]
  P --> R{Respondeu?}
  R -- vou renovar --> C[Cobrança + renovação confirmada<br/>depois, régua da Cobrança]
  R -- ainda pensando --> T[Combinado na hora<br/>retorno em 2 dias]
  T --> R
  R -- mudar plano/treinador --> X[Troca no contrato e cobrança]
  R -- atendente --> V[Revisão]
  R -- não vou renovar --> D[Despedida com pedido de feedback<br/>Não renovou]
  R -- não --> L2[2: Lembrete<br/>2 dias depois]
  L2 --> L3[3: Último dia do plano]
  L3 --> L4[4: Encerramento<br/>5 dias depois do fim]
  L4 --> N([Não renovou<br/>motivo: não respondeu])
```

- Entra no quadro a renovação manual 10 dias antes do fim do plano; a mensal
  automática entra 5 dias antes, direto em "Aguardando pagamento", sem Pebinha.
- Pebinha: "seu plano {plano} vence em {fim_plano}" (ou "venceu em"), com as 5
  opções de resposta.
- Sem resposta: lembrete 2 dias depois do Pebinha (se ainda faltar mais de 2
  dias para o fim), mensagem no último dia do plano e encerramento 5 dias
  depois do fim. Depois do encerramento, o card pede "Encerrar: não respondeu",
  que registra "Não renovou" com o motivo `no_response` ("Atleta não respondeu
  à renovação") pela janela segura de encerramento. Conta como saída.
- "Ainda pensando": a mensagem de combinado sai na hora ("em breve a gente
  retoma; posso te ajudar em algo?") e o retorno vem na data marcada (padrão:
  2 dias). Se continuar sem decisão, segue o último dia e o encerramento.
- "Não vou renovar": depois do encerramento seguro, abre a despedida
  (agradece e pede um feedback). O envio fica no histórico do contrato
  (`renewal_farewell_sent`), sem mudar o resultado.
- "Vou renovar": cadastro da cobrança e a mensagem "Sua renovação está
  confirmada". Na Central, a primeira cobrança da renovação usa o mesmo texto
  (modelo `billing-renewal-confirmed`); depois vale a régua da Cobrança.
- Um follow-up marcado à mão segura o próximo passo até a data. A data só
  ordena a fila: no quadro, cada card mostra o próximo passo ("Lembrete:
  hoje", "Último dia do plano: 14/10").
- Textos: modelos `renewal-*` em Comunicação → Modelos e regras (etapas
  "Contato de renovação" e "Respostas da renovação").

### Decisões

Decidido em 08/10/2026:

- Sem resposta: lembrete 2 dias depois do Pebinha e outro no último dia do plano.
- Encerramento 5 dias depois do fim, com a porta aberta, e a renovação vai para
  "Não renovou" (não respondeu).
- "Não vou renovar": mensagem agradecendo e pedindo feedback.
- "Ainda pensando": "em breve retomamos o contato, posso ajudar em algo?" e
  retorno 2 dias depois.

1. O que acontece com o treino de quem não paga a renovação (fica para depois).
