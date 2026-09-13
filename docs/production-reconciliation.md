# Reconciliação da produção — 12/09/2026

Esta etapa preserva no Git as correções já implantadas e acrescenta proteção de regressão para a operação atual: cadastro de cobrança externa e registro de pagamento externo/manual. A integração automática Asaas permanece preparada para uso futuro. Os testes não acessam o provedor nem usam registros reais.

## Referência preservada

- Frontend: commit `2bbcfc4b075fc666e535ad2deb7eb84ef3698b52`; Netlify deploy `6aa43e63c5c59af1f6dc1f24`.
- Supabase: projeto `bsiljrrodgtmtdilnuxr`; API principal `api-v1` v53 já coincidia com a `main`.
- Foram consultadas novamente e copiadas sem alteração as quatro funções divergentes. Versões e hashes estão em [production-baseline-2026-09-12.json](production-baseline-2026-09-12.json). O manifesto é um registro histórico, não uma ordem para republicar funções.

| Função | Comportamento implantado preservado |
| --- | --- |
| `generate-monthly-closing` v13 | Licenças abertas até o fim da competência; contratos cancelados até a data de cancelamento; competência obrigatória; preflight CORS antes da autenticação; somente POST executa. |
| `get-public-order` v7 | Consulta somente por `public_token`; não aceita ID interno como alternativa. |
| `fetch-asaas-receivables` v3 | Configuração implantada, inclusive fallback Asaas sandbox quando a variável de URL não existe. |
| `fetch-contract-installments` v3 | Configuração implantada, inclusive o mesmo fallback. |

Preservar o fallback existente não ativa o Asaas nem certifica sua configuração para uso futuro. Quando a integração for solicitada, validar explicitamente ambiente, credenciais e comportamento de falha. Nenhuma credencial faz parte deste registro.

## Histórico de migrações

Os dois arquivos abaixo foram apenas renomeados para corresponder às versões já registradas no banco. Os bytes SQL dos arquivos foram preservados, e seu conteúdo foi comparado com os statements remotos, normalizando comentários e espaços.

| Nome | Versão anterior no Git | Versão aplicada e adotada |
| --- | --- | --- |
| `redeploy_manual_payment_editable_installments` | `20260911120000` | `20260911163326` |
| `fix_stuck_manual_payment_flag_on_legacy_presale_orders` | `20260911170000` | `20260911165116` |

Não reaplicar essas operações nem executar repair no banco para acompanhar esta mudança de nomes. Não foi criada migração nova. O replay completo continua sendo validado no banco descartável do CI.

## Validação e publicação

Executar `npm run lint`, `npm test` e `npm run build`. Os cenários de cobrança externa e pagamento manual ficam em `supabase/functions/api-v1/`, com banco simulado e rede bloqueada no teste. Eles verificam o contrato HTTP→RPC, não substituem testes futuros das transações SQL em banco isolado.

O frontend e os handlers produtivos da `api-v1` não precisam mudar para esta reconciliação. O [workflow de publicação](deploy-production.md) passa a exigir as validações antes da API e o sucesso da API antes do frontend. O artefato inclui `netlify.toml`; a política de segurança existente precisa ser validada na prévia antes de integrar.

As funções auxiliares reconciliadas não são publicadas pelo workflow. Uma PR publica apenas prévia de frontend; integrar na `main` dispara produção. A prévia ainda pode usar o banco de produção: testar somente páginas públicas sem submissões e usar fixtures para operações financeiras. Algumas telas administrativas executam transições ao carregar, portanto navegar nelas não constitui necessariamente uma operação somente de leitura.

## Próximas etapas

Com esta referência preservada, corrigir em mudanças independentes: alteração pública de cadastro, erros silenciosos e HealthCheck, cache por sessão/entidade e definição única das métricas. Priorizar os fluxos externos/manuais usados hoje. Webhook, geração automática e demais caminhos específicos do provedor precisam ser endurecidos e testados antes da ativação futura da integração Asaas.
