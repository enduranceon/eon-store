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
