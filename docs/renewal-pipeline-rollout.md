# Implantação do quadro de renovações

## Sequência

1. Revisar o PR de banco, API e Central. O CI aplica todas as migrations em um banco local vazio, executa os testes SQL, testa as Edge Functions e publica uma prévia. A prévia pode apontar para o Supabase de produção: usá-la somente para inspeção visual e leitura, sem testar ações que gravem dados.
2. Antes do merge, conferir contratos elegíveis, filhos existentes e cobranças abertas com consultas somente leitura no schema atual. Conferir também o plano de migrations remoto (`supabase db push --linked --dry-run`). O backfill da migration cria sua cópia em `eon_private` antes de classificar os filhos existentes.
3. Com aprovação da implantação, fazer merge do PR de banco/API. O workflow da `main` valida migrations e testes, aplica a migration no projeto `bsiljrrodgtmtdilnuxr` e depois publica as Edge Functions. A tela antiga continua disponível durante essa etapa.
4. Verificar a versão da migration aplicada, permissões da RPC, contagem por `renewal_stage`, erros da rotina das 05:00 e as anomalias do relatório. Não alterar registros de produção como parte dessa conferência.
5. Revisar o PR da interface. Após o backend estar disponível e com aprovação, fazer merge do Kanban. O parâmetro `?view=legacy` mantém a tela anterior como rota de retorno operacional.
6. Durante sete dias, executar diariamente o relatório de qualidade, acompanhar erros de API/cron, cards abertos vencidos, follow-ups atrasados, assinaturas sem link e pagamentos sem etapa terminal. Investigar incoerências financeiras antes de corrigi-las.

## Retorno

- **Interface:** usar `/assessoria/renovacoes?view=legacy` imediatamente; se necessário, reverter somente o PR da interface e publicar a versão anterior. A tela antiga deve continuar lendo contratos normalmente.
- **API e rotina:** pausar o avanço do rollout e reverter o código da Edge Function se houver falha; conservar a migration aditiva e os eventos já registrados. Não executar um `DROP` ou limpar dados para voltar a tela.
- **Banco:** não há migration destrutiva de retorno. A tabela de backup em `eon_private` preserva o estado pré-backfill para auditoria. Qualquer correção de dados exige diagnóstico, cópia adicional e plano específico; não restaurar o backup em massa sobre pagamentos/eventos posteriores.

## Regras de operação

- A assinatura mensal automática é acompanhada internamente. O fluxo do quadro não cria cobrança no Asaas.
- Um link ausente não prova que a cobrança da assinatura não existe. Registrar o link existente não confirma pagamento.
- `waiting_payment` deve ser reconciliado com a mesma venda de `assessment_contracts` exibida no Financeiro.
- Resolver `not_renewed` pelo fluxo seguro existente; uma venda `voided` por erro não significa saída do atleta.
- Nunca usar uma prévia apontada para produção como ambiente para fixtures ou testes de escrita.
