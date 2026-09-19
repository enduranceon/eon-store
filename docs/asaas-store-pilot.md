# Asaas: piloto da loja

## Escopo e estado

Preparacao em branch de validacao, ainda sem ativacao. Conta Asaas exclusiva da EON Store.
O cliente faz o pedido normalmente; o administrador confere e gera a cobranca.
O usuario escolheu cartao, com possibilidade de parcelamento. O piloto permite
cartao de credito de 1 a 12 parcelas ou Pix a vista, limitado a UUIDs de pedidos
explicitamente liberados. Valor e numero de parcelas exigem confirmacao antes da emissao.
Assinaturas, assessoria, pre-vendas, eventos e boleto ficam fora do piloto.
Nao importar historico, criar clientes ficticios em producao ou apagar lancamentos.

## Validacao em 2026-09-19

- Branch local: `codex/asaas-store-webhook-safety`, baseada em `87ed502`.
- 209 testes de backend e 17 unitarios passaram; testes de backend sem acesso de rede.
- Checagem de tipos das seis funcoes alteradas e build passaram.
- Lint sem erros, com 12 avisos preexistentes em arquivos de frontend nao alterados.
- 64 verificacoes SQL haviam passado no esquema reduzido PGlite; a suite agora
  inclui mais sete verificacoes da visao financeira real, ainda pendentes no CI.
- A validacao completa precisa recriar toda a cadeia de migrations e executar
  `supabase test db --local` no job `Validate Supabase migrations` da PR.
- A branch segue para uma PR de testes. Nao fazer merge em `main`, aplicar a
  migration em producao ou ativar emissoes nesta etapa de validacao.
- Nenhuma chave Asaas foi utilizada e nenhuma cobranca real foi criada.

## Antes de conectar

1. Validar a migration com toda a cadeia no CI Supabase, incluindo os testes pgTAP.
   O smoke local com PGlite usa um esquema reduzido e nao substitui esse CI.
2. Revisar/publicar o codigo com a lista de pedidos ainda vazia. Isso bloqueia
   criacao de cobrancas mesmo que a chave ja exista no servidor.
3. Confirmar, por leitura, site e backend canonicos e a versao publicada.
4. Revisar notificacoes do cliente no Asaas: criar cobranca pode disparar avisos.
   Nao modificar preferencias de todos os clientes para este teste.
5. Usuario cria um pedido proprio pela loja. Conferir valor, estoque, dados,
   ausencia de pagamento manual/cobranca anterior e o UUID interno do pedido.

## Segredos e liberacao

Configurar diretamente nos segredos das Edge Functions do Supabase EON Store,
ref `bsiljrrodgtmtdilnuxr`. Nunca no frontend, em variaveis VITE, no Git ou no chat.

- `ASAAS_BASE_URL`: `https://api.asaas.com/v3`.
- `ASAAS_API_KEY`: chave de producao guardada pelo usuario.
- `ASAAS_STORE_WEBHOOK_TOKEN`: segredo independente aleatorio, minimo 32 caracteres.
- `ASAAS_STORE_PILOT_ORDER_IDS`: UUID do unico pedido autorizado; vazio desabilita.
  UUIDs adicionais separados por virgula somente apos autorizacao. Nao aceita `*`.
- `ASAAS_STORE_CHARGES_ENABLED`: manter ausente ou `false` ate autorizar a emissao.
  Somente o valor exato `true` permite gerar cobrancas para os pedidos da lista.

Somente depois da publicacao, configurar no Asaas o webhook especifico da loja:
`https://bsiljrrodgtmtdilnuxr.supabase.co/functions/v1/asaas-store-webhook`.
Usar envio sequencial e o mesmo segredo de `ASAAS_STORE_WEBHOOK_TOKEN` no campo
de token de autenticacao do webhook. Nao usar a chave de API como token.
Selecionar PAYMENT_CREATED, PAYMENT_UPDATED, PAYMENT_CONFIRMED, PAYMENT_RECEIVED,
PAYMENT_OVERDUE, PAYMENT_RESTORED, PAYMENT_DELETED e PAYMENT_REFUNDED.
Incluir os eventos de analise de risco, recusa e chargeback disponiveis na conta
para acompanhamento; neste piloto ficam para conferencia, sem baixa automatica.

Nao apontar este piloto para `asaas-webhook`: o receptor legado passa a retornar
`410 legacy_webhook_retired`, sem reconhecer eventos nem alterar dados.
`sync-asaas-payments` tambem fica desativado (`410 legacy_sync_retired`): o antigo
backfill podia apagar recebimentos manuais e sobrescrever os controles das parcelas.
Isso nao desativa cadastro de cobranca externa nem registro de pagamento manual.
As funcoes legadas de criacao passam a retornar `410 api_required`.
O frontend atual usa `api-v1`, com autenticacao administrativa e operation ledger.

## Criterios do primeiro pedido

- Usuario autoriza pedido, valor e numero de parcelas antes da emissao.
- Administrador emite a cobranca sem dados de cartao. O cliente abre `invoiceUrl`
  e preenche o cartao exclusivamente na pagina hospedada pelo Asaas, nunca no chat.
- Uma compra, com um vinculo ao grupo e um registro por parcela. Repetir comando
  nao deve criar outra cobranca; ambiguidades bloqueiam a operacao para conferencia.
- O webhook, sem botao de baixa manual, confirma o pedido e a projecao financeira.
- No cartao parcelado, todas as parcelas precisam estar confirmadas/recebidas para
  o pedido ficar pago. Isso nao exige esperar o credito futuro de cada parcela.
- No pedido autorizado, o botao de verificar consulta a projecao local do webhook;
  nao baixa o pedido nem sobrescreve as parcelas consultando so a primeira.
- Evento repetido nao cria novo recebimento ou efeito de estoque.
- Conferir valor bruto, liquido, taxa e datas por parcela. A soma do grupo deve
  corresponder ao total da compra; nao criar outro recebimento pelo total.
- Confirmacao financeira nao muda automaticamente a entrega.
- Cancelamentos/estornos nao sao limpeza de fixture: exigem decisao explicita e
  o fluxo canonico, com preservacao de estoque, cupons e historico financeiro.
- Um evento de estorno/cancelamento de parcela fica para conferencia; nao e
  interpretado como estorno/cancelamento automatico da compra inteira.

## Recebimento e recuperacao

O evento e a alteracao financeira sao uma transacao. Falha de persistencia retorna
503, nunca 200. Se o evento chegar antes do vinculo da cobranca, fica `pending`
e tambem retorna 503 para o Asaas reenviar. Acompanhar a fila de entrega: esse
reprocessamento depende das tentativas do Asaas, nao ha worker local.

Eventos fora dos pedidos liberados ficam `ignored`, sem inserir cobrancas de
assinaturas antigas no financeiro. Divergencias ficam `reconciliation_required`,
persistidas antes do HTTP 200, e exigem conferencia. Nao existe baixa automatica
para essas divergencias; nao redefinir eventos como pendentes sem analisar a causa.

Consulta administrativa read-only durante o piloto (nao imprime payload/PII):

```sql
select event_id, event_type, payment_id, status, reason, order_id, received_at
from public.asaas_store_webhook_events
where status in ('pending', 'reconciliation_required')
order by received_at;
```

Somente campos financeiros permitidos do payload ficam em tabela com RLS e sem
acesso por anon/authenticated. O objeto de cartao, incluindo token reutilizavel,
e descartado antes da persistencia no historico e no cache financeiro. Nao
exportar dados de clientes para tickets ou logs. Definir retencao antes de ampliar.

Para interromper **novas emissoes**, definir `ASAAS_STORE_CHARGES_ENABLED=false`.
Isso nao interrompe o webhook: preservar os UUIDs e o token de recebimento ate
resolver cobrancas ja emitidas. Retirar um UUID tambem exclui seu recebimento.
Desabilitar o webhook ou revogar uma chave nao cancela cobrancas existentes.

## Referencias

- https://docs.asaas.com/docs/chaves-de-api
- https://docs.asaas.com/docs/como-implementar-idempotencia-em-webhooks
- https://docs.asaas.com/docs/webhook-para-cobrancas
- https://docs.asaas.com/docs/cobrancas-via-cartao-de-credito
- https://docs.asaas.com/docs/criar-uma-cobranca-parcelada
