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
- Priorizar testes dos fluxos externos/manuais com dados ficticios e dependencias simuladas. Nao usar clientes, pedidos ou contratos reais como fixtures.
- A tabela `asaas_payments` tambem guarda lancamentos manuais (`source = 'manual'`). Seu nome nao significa que a API Asaas esta em uso; preservar esses lancamentos e suas regras financeiras.
- Uma previa de frontend pode apontar para o Supabase de producao. Conferir o backend antes de testar qualquer acao que escreva dados; uma URL de preview nao isola o banco.

## Site (enduranceon-site)

- O site le planos e coaches de `public-assessment-prospect` (Store). Cada coach pode ter um plano por modalidade e duracao so para o site (Coaches > "Planos que vende no site"; tabela `assessment_coach_site_plans`); a venda interna usa qualquer plano. Contrato da API: `docs/site-planos-por-coach.md`.
- Lista de espera por coach: Equipe > "Recebe novos alunos" desmarcado deixa o coach em lista de espera no site (o cadastro do site recusa com `COACH_WAITLIST`; a venda interna continua liberada). O site envia a pessoa para `public-coach-waitlist`; a fila fica em Assessoria > Lista de espera (tabela `assessment_coach_waitlist`). Contrato da API: `docs/lista-de-espera-coach.md`.
- Planos agrupados (`assessment_plan_families`; cada duracao segue em `assessment_plans` com `family_id`) e link do plano para WhatsApp (`/plano/:segredo`, opcional `?coach=`; funcao `public-plan-link`; prospect com `source = 'plan_link'`; link com e sem matricula, cada um com seu segredo): `docs/link-do-plano.md`.
- Formulario de match dos coaches (`coach-match-admin`, `coach-match-form`, `public-coach-match`): `docs/coach-match-workflow.md`.

## Comunicacao com alunos

- Regras e fluxogramas das conversas da Central de Comunicacao (onboarding, proposta, cobranca e renovacao): `docs/fluxos-de-mensagens.md`.
- Onboarding vale para a primeira adesao e para o ex-aluno que volta depois de mais de 30 dias sem contrato, com pagamento nos ultimos 30 dias. Renovacao (inclusive atrasada ate 30 dias), historico importado e aluno migrado que so continuou ficam de fora.
- Onboarding em tres passos (boas-vindas, check-in no dia 5, feedback no dia 20). O envio e manual e sem travas: copiar o texto e "Registrar que enviei".
- Proposta no quadro de Prospects: primeiro contato sem link, respostas marcadas no card, lembrete no dia 2 e encerramento no dia 5; com link, lembrete no dia seguinte ao vencimento e encerramento 5 dias depois com mais 2 dias de link ativo. Antes de cobrar, o card so consulta o Asaas (mesma regra do botao de Cobrancas); nada e arquivado nem pago sozinho. Textos editaveis em Modelos e regras (jornada `proposal`); prospect arquivado pode ser retomado (volta para Tirando duvidas, historico preservado).
- Cobranca na Central: cobranca com link, lembrete na vespera (trimestral e semestral, ligado desde 2026-10-08), vencida todo dia a partir do 3o dia ate a pessoa responder (mensagem unica com dias de atraso e referencia); resposta registrada pausa a regua. "Desconsiderar mensagem" pula o passo sem envio. Prospect em rascunho nao entra (fica no quadro de Prospects).
- Renovacao: Pebinha 10 dias antes do fim; sem resposta, lembrete 2 dias depois, mensagem no ultimo dia do plano e encerramento 5 dias depois do fim, que leva a "Nao renovou" com motivo `no_response` pela janela segura. "Ainda pensando" recebe o combinado na hora e retorno em 2 dias; "Nao vou renovar" recebe a despedida com pedido de feedback (so historico). Mensal automatica fica fora da regua (vai direto para Aguardando pagamento, sinalizada "Sem link" ate o link da fatura); automatica so no plano mensal (assinatura no Asaas). Contrato em licenca sem data de volta nao entra na renovacao (desde 2026-10-17): os dias parados so somam ao fim quando a licenca e encerrada; a renovacao nasce 10 dias antes do novo fim.

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
- Frete (desde 2026-10-21): cobrado depois do envio, em todo pedido com frete. Etapa Enviado (`delivery_status = 'shipped'`, rastreio, `shipping_cost` = quanto foi pago) por `mark_order_shipped`; com valor a cobrar, nasce a cobranca do frete (pedido da loja so com o item Frete, ligado por `shipping_parent_type/id`, uma aberta por pedido). O custo e despesa da loja em `financial_movements` (`source = 'shipping_cost'`). Enviado conta como entregue para estoque e devolucao. Detalhes: `docs/frete.md`.
