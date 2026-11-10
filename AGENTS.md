# EON Store - contexto operacional para agentes

Este arquivo guarda apenas referencias operacionais do projeto. Nao colocar tokens, service role keys, senhas, JWTs ou dados sensiveis aqui.

## Servicos canonicos

- GitHub: `enduranceon/eon-store`
- Branch principal: `main`
- Netlify site ID: `9a9edc3b-04e4-431f-8927-f946900b0b27`
- Netlify project: `eon-store`
- Netlify producao: `https://eon-store.netlify.app`
- Supabase projeto: `EON Store`
- Supabase project ID/ref: `bsiljrrodgtmtdilnuxr`

Quando houver outros projetos Supabase visiveis, usar `bsiljrrodgtmtdilnuxr` para este software, salvo instrucao explicita do usuario.

## Sistema irmao: EON Hub

- GitHub: `enduranceon/eon-hub` (operacao: treinos, Strava/Intervals, portal do atleta).
- Supabase do Hub: `qsaowltbnefzpbphhwmr` (us-east-1). Nao e o banco desta aplicacao; ali, so leitura, salvo pedido explicito do usuario.
- Os alunos ainda sao cadastrados a mao nos dois sistemas. Diagnostico, desenho recomendado e decisoes pendentes da integracao: `docs/eon-hub-integration.md`. Nada implementado ate 2026-10-06.

## Operacao financeira atual

- Confirmado pelo usuario em 2026-09-12: a operacao usa cadastro de cobranca externa e registro de pagamento externo/manual.
- A integracao automatica com a API Asaas esta preparada para uso futuro e ainda nao e o fluxo operacional. Nao ativa-la nem fazer cobrancas, cancelamentos ou estornos no provedor durante manutencao ou testes.
- Excecao pedida pelo usuario em 2026-10-06 (e estendida em 2026-10-08 ao quadro de Prospects: lembrete de pagamento, encerramento com link e "Conferir no Asaas" da coluna Link enviado): o botao "Conferir pagamentos no Asaas" (tela Cobrancas, rota `POST /asaas/payment-check` do `api-v1`) so consulta (GET) as cobrancas cujo link externo e uma fatura do Asaas (`https://www.asaas.com/i/<codigo>` = cobranca `pay_<codigo>`). Nao cria, altera, cancela nem estorna nada no provedor; o pagamento so e registrado pelo fluxo manual, depois que o administrador confirma, com o valor e a data de credito de cada parcela vindos do Asaas e sem registrar taxas. So entra como paga se o documento do cliente da fatura no Asaas for o CPF da pessoa da venda ou o CNPJ opcional cadastrado na ficha dela (`presale_customers.cnpj`, desde 2026-10-14, para quem paga pela empresa; o CPF continua sendo a identidade do cadastro), e a gravacao passa por uma segunda consulta ao Asaas e por uma tela de confirmacao. Exige `ASAAS_API_KEY` e `ASAAS_BASE_URL` nos secrets das Edge Functions (nunca no Git, no frontend ou no chat). Testes usam respostas simuladas do Asaas.
- Excecao pedida pelo usuario em 2026-10-23: a renovacao mensal automatica e uma assinatura no Asaas, e o link da fatura do mes e buscado sozinho (todo dia em `prepare-renewals` e pelo botao "Buscar link no Asaas" do card, rota `POST /renewals/subscription-link`). Tambem so consulta (GET `/payments/pay_<codigo>` para achar a assinatura e GET `/subscriptions/<id>/payments`); grava o link como cobranca externa so se o CPF/CNPJ for o da pessoa. Sem mensagem de cobranca no WhatsApp para essas renovacoes (o Asaas avisa a pessoa). O botao "Conferir assinaturas no Asaas" do quadro de Renovacoes (`POST /renewals/subscription-check`) lista os planos mensais com a automatica desligada e procura, so consultando (GET `/customers?cpfCnpj=` e GET `/subscriptions?customer=`), quem tem assinatura mensal ativa; "Ligar automatica" consulta de novo e guarda a assinatura no contrato. A mesma conferencia, so a lista e sem gravar nada, sai de `prepare-renewals` com `{ "subscription_check": true }`. Detalhes em `docs/fluxos-de-mensagens.md` (Renovacao).
- O mesmo link de cobranca externa nao entra em dois contratos (desde 2026-11-03): `save_assessment_contract_external_charge` recusa um link que outro contrato (fora cancelado e anulado) ja usa e diz qual e, mesmo com barra no fim. So vale quando o link do contrato muda; salvar de novo o mesmo link com outro vencimento continua funcionando. Um link de fatura do Asaas e uma cobranca so: o link ja pago de um mes colado no mes seguinte (caso ASS-000249/ASS-000364, 2026-10-08) deixa a pessoa sem fatura para pagar.
- Excecao pedida pelo usuario em 2026-11-05: carne de boleto/PIX parcelado do Asaas (caso ASS-002179, link registrado como "Cartao 3x" e pago em boleto/PIX parcelado). O card "Parcelas do Asaas" do contrato (`ContractParcelsCard`, rotas `/orders/contract/:id/parcels/*` do `api-v1`, tabela `assessment_contract_parcels`) so le o Asaas (GET `/payments/pay_<codigo>` para achar o parcelamento e GET `/installments/<id>/payments`); o parcelamento continua sendo criado a mao la. Cada parcela guarda o seu link; o pagamento de cada uma so e registrado depois que o Asaas mostra a parcela paga e o CPF/CNPJ da fatura e o da pessoa, como linha manual confirmada em `asaas_payments` (sem taxas). Contrato com carne fica `partially_paid` ate a ultima parcela e `paid` ao fechar; a renovacao conta como "Renovou" na primeira parcela registrada (decisao do usuario, 2026-11-05) e o prospect converte na primeira. O repasse do coach continua exigindo `paid` (regra "em dia" da fase 3 ainda nao decidida). "Receber", "Reabrir pagamento" e trocar/remover a cobranca externa recusam contrato com carne; cancelar com parcela registrada mantem `partially_paid` (estorno do carne fica para a fase 2). Detalhes em `docs/api-v1.md`.
- Carne na conferencia de Cobrancas e nas vendas em aberto (desde 2026-11-07): "Conferir pagamentos no Asaas" reconhece o boleto/PIX parcelado de contrato (carne). Se ao menos uma parcela esta paga e o CPF/CNPJ confere, o item vem marcado como pronto e, na confirmacao (que consulta o Asaas de novo), importa as parcelas (se ainda nao importadas) e registra as pagas, uma de cada vez (`registerCarneItem`); o contrato vira "Renovou" na primeira. Carne ja importado e "pago parcial" continua na conferencia para pegar as proximas parcelas pagas (`asaas-payment-check.ts` so o trata como encerrado quando todas as parcelas estao registradas). Em Financeiro > Vendas em aberto, o contrato com carne some e cada parcela sem registro vira uma linha (valor, vencimento, link, "Carne n/N"; sem "Receber" nem "Alterar vencimento"); `isOpenCollectionSale` e `isOpenSaleForFinancial` tratam `partially_paid` como saldo em aberto, mas `PAID_PAYMENT_STATUSES` continua com ele (tempo de casa, renovacao). A Central usa o saldo do carne (soma das parcelas sem registro, `communication_open_balance`) e o contrato guarda o link e o vencimento da proxima parcela em aberto, entao a parcela vencida cai na regua de atraso com o link dela. As parcelas em aberto ainda nao entram no fluxo de caixa como "a receber" (so o que foi recebido entra).
- Visao geral (`/admin`, desde 2026-11-09, `docs/visao-geral.md`): pagina de entrada, so leitura (nao grava, nao chama o Asaas). Alunos ativos = pessoas unicas com contrato ativo pela classificacao canonica do ciclo de vida; MRR = valor contratado; Vencido = saldo aberto com vencimento antes de hoje, mesma fonte de Cobrancas (`src/lib/open-sales-source.js`); Recebimentos do ano = so o que entrou (o sistema ainda nao controla saidas: nada de saida, resultado ou caixa, nem zero no lugar), mes futuro ou sem historico fica sem valor (nunca zero) e cada bloco falha sozinho. `/hoje` agora so redireciona para `/admin` (a fila do dia foi trocada pela faixa Atencao); `Dashboard.jsx` e `Today.jsx` foram removidos.
- Eventos, coaches responsaveis, grupo do WhatsApp e login do coach (desde 2026-11-09, `docs/coach-eventos.md`): o evento tem varios coaches responsaveis (`event_coaches`, trocados de uma vez por `PUT /events/:id/coaches`) e pode marcar `whatsapp_group_enabled`; nesse caso cada inscricao PAGA mostra se a pessoa ja esta no grupo (`whatsapp_group_status`: pending, added, declined; a equipe e o coach responsavel marcam). O coach entra em `/login` com conta do Supabase Auth ligada a `assessment_coaches.auth_user_id` (criada pela equipe em Assessoria > Coaches > Acesso, com senha provisoria mostrada uma vez) e usa so a area `/coach`, que fala unicamente com a edge function `coach-api`: ve so eventos em que e responsavel, so para olhar (alem de marcar o grupo), sem valores, ganhos, cobrancas, CPF, e-mail nem observacoes internas. Regras de seguranca que NAO podem quebrar: o banco continua fechado (usuario logado que nao e administrador le 0 linhas e nao grava; `supabase/tests/coach_login_test.sql` varre todas as tabelas), o coach nunca recebe `to_jsonb(linha)` (as funcoes `coach_*` devolvem lista fixa de campos, com teste das chaves), a identidade vem so do token e `api-v1` segue exigindo administrador. Conta de administrador nunca vira conta de coach. Painel do coach (desde 2026-11-10, `GET /panel` da `coach-api`): alunos, entradas e saidas calculados NO SERVIDOR com todos os contratos e as mesmas regras do perfil do coach da equipe (`coach-profile.js`), devolvendo so o coach logado, sem mensalidade, pagamento atrasado, contato nem ids (teste confere as chaves). Os modulos de calculo de metricas da assessoria agora vivem em `supabase/functions/_shared/assessment-metrics/` e `src/lib/<nome>.js` so reexporta; instante em texto vira dia no fuso de Brasilia (`dates.js`) e o servidor sempre passa o `today` de Brasilia (teste em quatro fusos). Proximas etapas do perfil: recebimentos (so fechamento aprovado), previsao do mes (conta do fechamento), renovacoes/prospects.
- Priorizar testes dos fluxos externos/manuais com dados ficticios e dependencias simuladas. Nao usar clientes, pedidos ou contratos reais como fixtures.
- A tabela `asaas_payments` tambem guarda lancamentos manuais (`source = 'manual'`). Seu nome nao significa que a API Asaas esta em uso; preservar esses lancamentos e suas regras financeiras.
- Uma previa de frontend pode apontar para o Supabase de producao. Conferir o backend antes de testar qualquer acao que escreva dados; uma URL de preview nao isola o banco.

## Site (enduranceon-site)

- O site le planos e coaches de `public-assessment-prospect` (Store). Cada coach pode ter um plano por modalidade e duracao so para o site (Coaches > "Planos que vende no site"; tabela `assessment_coach_site_plans`); a venda interna usa qualquer plano. Contrato da API: `docs/site-planos-por-coach.md`.
- Nascimento e gênero no cadastro do site (2026-10-29): `public-assessment-prospect` aceita `birth_date` (AAAA-MM-DD, de 1900 até hoje) e `gender` (`masculino`, `feminino`, `outro` ou vazio), ambos opcionais no servidor para o formulário antigo continuar funcionando; a obrigatoriedade da data fica no formulário novo do site. Cliente novo já nasce com os dois em `presale_customers`; cliente existente (mesmo CPF) não é alterado e o enviado fica no comprovante (`submitted_birth_date`, `submitted_gender`), visível no card de Prospects. O link do plano (`submit_plan_link_prospect`, página `/plano/:segredo`) também envia os dois (2026-10-29), com as mesmas regras.
- Lista de espera por coach: Equipe > "Recebe novos alunos" desmarcado deixa o coach em lista de espera no site (o cadastro do site recusa com `COACH_WAITLIST`; a venda interna continua liberada). O site envia a pessoa para `public-coach-waitlist`; a fila fica em Assessoria > Lista de espera (tabela `assessment_coach_waitlist`). Contrato da API: `docs/lista-de-espera-coach.md`.
- Contatos do site: o formulário de contato do site envia a mensagem para `public-contact-request`; a fila fica em Assessoria > Contatos do site (`/assessoria/contatos-do-site`, tabela `assessment_contact_requests`, entidade `contact-requests` do `api-v1`). A equipe responde e, se a pessoa quiser treinar, cria o prospect a partir do contato (um prospect exige plano e coach, por isso a mensagem solta não entra direto no quadro). Mesmas proteções da lista de espera (origens do site, Turnstile ação `contact_submit`, campo isca, limite de tentativas). Contrato da API: `docs/contatos-do-site.md`.
- Planos agrupados (`assessment_plan_families`; cada duracao segue em `assessment_plans` com `family_id`) e link do plano para WhatsApp (`/plano/:segredo`, opcional `?coach=`; funcao `public-plan-link`; prospect com `source = 'plan_link'`; link com e sem matricula, cada um com seu segredo): `docs/link-do-plano.md`.
- Formulario de match dos coaches (`coach-match-admin`, `coach-match-form`, `public-coach-match`): `docs/coach-match-workflow.md`.

## Comunicacao com alunos

- Regras e fluxogramas das conversas da Central de Comunicacao (onboarding, proposta, cobranca e renovacao): `docs/fluxos-de-mensagens.md`.
- Onboarding vale para a primeira adesao e para o ex-aluno que volta depois de mais de 30 dias sem contrato, com pagamento nos ultimos 30 dias. Renovacao (inclusive atrasada ate 30 dias), historico importado e aluno migrado que so continuou ficam de fora.
- Onboarding em tres passos (boas-vindas, check-in no dia 5, feedback no dia 20). O envio e manual e sem travas: copiar o texto e "Registrar que enviei".
- Proposta no quadro de Prospects: primeiro contato sem link, respostas marcadas no card, lembrete no dia 2 e encerramento no dia 5; com link, lembrete no dia seguinte ao vencimento e encerramento 5 dias depois com mais 2 dias de link ativo. Antes de cobrar, o card so consulta o Asaas (mesma regra do botao de Cobrancas); nada e arquivado nem pago sozinho. Textos editaveis em Modelos e regras (jornada `proposal`); prospect arquivado pode ser retomado (volta para Tirando duvidas, historico preservado).
- Cobranca na Central: cobranca com link, lembrete na vespera (trimestral e semestral, ligado desde 2026-10-08), vencida todo dia a partir do 3o dia ate a pessoa responder (mensagem unica com dias de atraso e referencia); resposta registrada pausa a regua. "Desconsiderar mensagem" pula o passo sem envio. Prospect em rascunho nao entra (fica no quadro de Prospects).
- Renovacao: Pebinha 10 dias antes do fim; sem resposta, lembrete 2 dias depois, mensagem no ultimo dia do plano e encerramento 5 dias depois do fim, que leva a "Nao renovou" com motivo `no_response` pela janela segura. "Ainda pensando" recebe o combinado na hora e retorno em 2 dias; "Nao vou renovar" recebe a despedida com pedido de feedback (so historico). Mensal automatica fica fora da regua (vai direto para Aguardando pagamento, sinalizada "Sem link" ate o link da fatura); automatica so no plano mensal (assinatura no Asaas). Renovacao automatica so deixa de comecar sozinha se a automatica do contrato anterior foi desligada depois de ela nascer (desde 2026-10-23). Contrato em licenca sem data de volta nao entra na renovacao (desde 2026-10-17): os dias parados so somam ao fim quando a licenca e encerrada; a renovacao nasce 10 dias antes do novo fim. A conferencia do quadro (`assessment_renewal_pipeline_issues`) segue a mesma regra: contrato em licenca sem data de volta nao aparece em "Renovacao deveria estar no quadro" nem em "Contrato venceu sem renovacao" (desde 2026-11-03). Ao encerrar a licenca (`finish_assessment_contract_leave`), o status (ativo ou vencido) e decidido com o fim ja somado aos dias parados, e nao com o fim de antes (desde 2026-11-03; a regra de somar os dias da licenca ao fim nao mudou). A licenca sem data de volta pode ser encerrada num dia passado (desde 2026-11-04): o dia escolhido e o ultimo dia de licenca (conta como dia parado) e os dias somados ao fim sao (ultimo dia - inicio) + 1; nao pode ser antes do inicio, no futuro nem em mes de repasse ja aprovado ou pago (`eon_private.first_open_payout_day`), e a tela avisa quando o fechamento em revisao precisa ser gerado de novo.

## Preflight antes de mudancas relevantes

1. Conferir branch, remotes e estado local:
   - `git remote -v`
   - `git branch -vv`
   - `git status --short`
2. Conferir se o local nao esta defasado em relacao ao GitHub antes de deploy ou mudanca grande:
   - `git fetch origin`
   - `git status --short --branch`
3. Conferir Netlify quando a pergunta envolver producao/deploy:
   - site ID esperado: `9a9edc3b-04e4-431f-8927-f946900b0b27`
   - projeto esperado: `eon-store`
4. Conferir Supabase com consulta read-only antes de analisar dados reais:
   - projeto esperado: `bsiljrrodgtmtdilnuxr`
   - query minima:

```sql
select
  exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'assessment_contracts'
  ) as has_assessment_contracts,
  exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'presale_orders'
  ) as has_presale_orders;
```

## Conectores e CLIs

- GitHub MCP esta disponivel para consultar/criar PRs, mas o `gh` CLI pode nao estar instalado.
- Supabase MCP esta disponivel e deve ser preferido para queries SQL read-only e verificacoes de projeto.
- Netlify MCP esta disponivel. O Netlify CLI via `npx netlify` tambem pode estar autenticado, mas pode precisar de permissao fora do sandbox.
- Supabase CLI pode nao estar instalado localmente. Nao depender dele sem verificar.

## Regras de seguranca operacional

- Nao fazer deploy a partir de uma branch/local defasado.
- Nao fazer alteracao destrutiva em dados sem backup/export e confirmacao explicita.
- Para auditorias, comecar sempre por leitura e classificacao; evitar `update`, `delete`, `insert` ou migrations na primeira passada.
- Antes de mexer em metricas de assessoria, lembrar que contrato, cobranca, pagamento e estorno sao conceitos diferentes. As telas Evolucao (`/assessoria/indicadores`) e Entradas e saidas (`/assessoria/movimento`) usam a mesma classificacao (`classifyAssessmentContracts` em `src/lib/assessment-yearly-indicators.js`); O perfil do coach (`/assessoria/coaches/:id`, `src/lib/coach-profile.js`) tambem. Painel e Analytics ainda usam a do ciclo de vida do contrato.
- Nomes de pessoas sao padronizados no banco (`eon_private.format_person_name`, desde 2026-10-13): iniciais maiusculas e "da/de/do/das/dos/e" minusculos, por gatilho em `presale_customers`, `assessment_coaches`, `presale_trainers`, `assessment_coach_waitlist` e `tecnofit_archive_clients`. O envio original do site (`assessment_prospect_submissions`) e o nome digitado no pedido da loja ficam como recebidos; comparacoes de nome devem ignorar maiusculas. Copia dos nomes antigos: `eon_private.person_name_format_backup_20261013`.
- Saida/churn so deve representar encerramento real do aluno na assessoria, nao troca de plano, ajuste financeiro, venda descartada ou correcao de cobranca.
- Comissao de produto (desde 2026-10-16): regra no produto (`products.commission_type` percent|fixed), coach no pedido (`coach_id`, do contrato ativo, editavel), regra registrada quando o pedido passa a pago (`commission_snapshot`) e livro so de lancamentos novos (`product_commissions`, ajustes por gatilho). Entra no repasse como `product_commission`, pelo mes do pagamento. Pedidos pagos antes nunca geram comissao. Detalhes: `docs/comissao-de-produto.md`.
- Pro rata do plano mensal (desde 2026-10-27): cartao Pro rata na ficha do contrato, antes do pagamento. O primeiro periodo termina no dia do ciclo (1 a 28) e custa mensal / 30 x dias (`plan_snapshot.prorata`, `apply_assessment_contract_prorata`); a renovacao seguinte volta ao valor cheio, do dia do ciclo ao dia do ciclo. So mensal. Detalhes: `docs/pro-rata.md`.
- Frete (desde 2026-10-21): cobrado depois do envio, em todo pedido com frete. Etapa Enviado (`delivery_status = 'shipped'`, rastreio, `shipping_cost` = quanto foi pago) por `mark_order_shipped`; com valor a cobrar, nasce a cobranca do frete (pedido da loja so com o item Frete, ligado por `shipping_parent_type/id`, uma aberta por pedido). O custo e despesa da loja em `financial_movements` (`source = 'shipping_cost'`). Enviado conta como entregue para estoque e devolucao. Detalhes: `docs/frete.md`.
