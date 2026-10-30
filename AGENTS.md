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
- Renovacao: Pebinha 10 dias antes do fim; sem resposta, lembrete 2 dias depois, mensagem no ultimo dia do plano e encerramento 5 dias depois do fim, que leva a "Nao renovou" com motivo `no_response` pela janela segura. "Ainda pensando" recebe o combinado na hora e retorno em 2 dias; "Nao vou renovar" recebe a despedida com pedido de feedback (so historico). Mensal automatica fica fora da regua (vai direto para Aguardando pagamento, sinalizada "Sem link" ate o link da fatura); automatica so no plano mensal (assinatura no Asaas). Renovacao automatica so deixa de comecar sozinha se a automatica do contrato anterior foi desligada depois de ela nascer (desde 2026-10-23). Contrato em licenca sem data de volta nao entra na renovacao (desde 2026-10-17): os dias parados so somam ao fim quando a licenca e encerrada; a renovacao nasce 10 dias antes do novo fim.

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
- Capa da pagina de inscricao do evento (desde 2026-10-30): faixa 4:1 (1600 x 400 px) no topo de `/inscricao/:slug`, enviada na ficha do evento. Arquivo no bucket publico `event-covers`, caminho em `events.cover_image_path`, envio por URL assinada da `api-v1`. Detalhes: `docs/capa-do-evento.md`.
- Frete (desde 2026-10-21): cobrado depois do envio, em todo pedido com frete. Etapa Enviado (`delivery_status = 'shipped'`, rastreio, `shipping_cost` = quanto foi pago) por `mark_order_shipped`; com valor a cobrar, nasce a cobranca do frete (pedido da loja so com o item Frete, ligado por `shipping_parent_type/id`, uma aberta por pedido). O custo e despesa da loja em `financial_movements` (`source = 'shipping_cost'`). Enviado conta como entregue para estoque e devolucao. Detalhes: `docs/frete.md`.
