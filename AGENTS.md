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
- Excecao pedida pelo usuario em 2026-10-06 (e estendida em 2026-10-08 ao quadro de Prospects: lembrete de pagamento, encerramento com link e "Conferir no Asaas" da coluna Link enviado): o botao "Conferir pagamentos no Asaas" (tela Cobrancas, rota `POST /asaas/payment-check` do `api-v1`) so consulta (GET) as cobrancas cujo link externo e uma fatura do Asaas (`https://www.asaas.com/i/<codigo>` = cobranca `pay_<codigo>`). Nao cria, altera, cancela nem estorna nada no provedor; o pagamento so e registrado pelo fluxo manual, depois que o administrador confirma, com o valor e a data de credito de cada parcela vindos do Asaas e sem registrar taxas. So entra como paga se o CPF do cliente da fatura no Asaas for o mesmo da venda, e a gravacao passa por uma segunda consulta ao Asaas e por uma tela de confirmacao. Exige `ASAAS_API_KEY` e `ASAAS_BASE_URL` nos secrets das Edge Functions (nunca no Git, no frontend ou no chat). Testes usam respostas simuladas do Asaas.
- Priorizar testes dos fluxos externos/manuais com dados ficticios e dependencias simuladas. Nao usar clientes, pedidos ou contratos reais como fixtures.
- A tabela `asaas_payments` tambem guarda lancamentos manuais (`source = 'manual'`). Seu nome nao significa que a API Asaas esta em uso; preservar esses lancamentos e suas regras financeiras.
- Uma previa de frontend pode apontar para o Supabase de producao. Conferir o backend antes de testar qualquer acao que escreva dados; uma URL de preview nao isola o banco.

## Comunicacao com alunos

- Regras e fluxogramas das conversas da Central de Comunicacao (onboarding, proposta, cobranca e renovacao): `docs/fluxos-de-mensagens.md`.
- Onboarding vale para a primeira adesao e para o ex-aluno que volta depois de mais de 30 dias sem contrato, com pagamento nos ultimos 30 dias. Renovacao (inclusive atrasada ate 30 dias), historico importado e aluno migrado que so continuou ficam de fora.
- Onboarding em tres passos (boas-vindas, check-in no dia 5, feedback no dia 20). O envio e manual e sem travas: copiar o texto e "Registrar que enviei".
- Proposta no quadro de Prospects: primeiro contato sem link, respostas marcadas no card, lembrete no dia 2 e encerramento no dia 5; com link, lembrete no dia seguinte ao vencimento e encerramento 5 dias depois com mais 2 dias de link ativo. Antes de cobrar, o card so consulta o Asaas (mesma regra do botao de Cobrancas); nada e arquivado nem pago sozinho. Textos editaveis em Modelos e regras (jornada `proposal`); prospect arquivado pode ser retomado (volta para Tirando duvidas, historico preservado).
- Cobranca na Central: cobranca com link, lembrete na vespera (trimestral e semestral, ligado desde 2026-10-08), vencida todo dia a partir do 3o dia ate a pessoa responder (mensagem unica com dias de atraso e referencia); resposta registrada pausa a regua. "Desconsiderar mensagem" pula o passo sem envio. Prospect em rascunho nao entra (fica no quadro de Prospects).
- Renovacao: Pebinha 10 dias antes do fim; sem resposta, lembrete 2 dias depois, mensagem no ultimo dia do plano e encerramento 5 dias depois do fim, que leva a "Nao renovou" com motivo `no_response` pela janela segura. "Ainda pensando" recebe o combinado na hora e retorno em 2 dias; "Nao vou renovar" recebe a despedida com pedido de feedback (so historico). Mensal automatica fica fora da regua (vai direto para Aguardando pagamento, sinalizada "Sem link" ate o link da fatura); automatica so no plano mensal (assinatura no Asaas).

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
- Antes de mexer em metricas de assessoria, lembrar que contrato, cobranca, pagamento e estorno sao conceitos diferentes.
- Saida/churn so deve representar encerramento real do aluno na assessoria, nao troca de plano, ajuste financeiro, venda descartada ou correcao de cobranca.
