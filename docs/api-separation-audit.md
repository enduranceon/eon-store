# Auditoria da separação entre frontend e backend

Atualizada em 2026-07-27. A separação das gravações foi concluída: o navegador
mantém leituras protegidas por RLS, enquanto toda mutação administrativa passa
pela `api-v1` com JWT e cliente privilegiado somente no backend.

## Estado final

- não há `insert`, `update`, `upsert` ou `delete` direto no código do frontend;
- todos os cadastros administrativos usam allowlists de campos na API;
- mesclagem de clientes e troca de itens de venda são transações no Postgres;
- comunicação, regras, importação legada e fechamento usam comandos autenticados;
- `anon` e `authenticated` não possuem grants de escrita em tabelas públicas;
- entradas públicas continuam limitadas aos RPCs dedicados e validados.

## Domínios atendidos pela API autenticada

- sessão e autorização administrativa;
- devoluções, cancelamentos, estornos e cancelamento parcial de itens;
- pagamentos manuais, cobranças Asaas e cobranças externas;
- pedidos, estoque, entrega, descontos e alteração de itens;
- contratos, renovações, pausas, trocas, encerramentos e não renovação;
- campanhas, produtos, clientes, cupons e catálogos administrativos;
- regras e histórico da Central de Comunicação;
- planos, modalidades, coaches, regras de renovação, repasses e fechamentos;
- importação dos dados legados do armazenamento local.

## Entradas públicas

O checkout e a adesão pública não reutilizam as rotas administrativas. Eles
continuam em RPCs ou rotas públicas específicas, com payload restrito,
recalculo autoritativo no banco e sem grants de escrita em tabelas para `anon`.

## Defesa em profundidade

1. a Edge Function valida o JWT e confirma que o usuário está na allowlist de
   administradores;
2. cada rota aceita somente recursos, campos, tipos, tamanhos e transições
   explicitamente permitidos;
3. operações compostas ou financeiras usam RPCs transacionais server-only;
4. o frontend não recebe a `service_role`;
5. grants de escrita de `anon` e `authenticated` foram revogados no schema
   `public` e também nos privilégios padrão de tabelas futuras;
6. as políticas permissivas temporárias do rollout foram removidas.

## Critério de regressão

Qualquer novo fluxo deve ser considerado incompleto se introduzir mutação
direta com o cliente Supabase do navegador. A mudança precisa incluir rota
autenticada, allowlist de entrada, teste automatizado e revisão dos grants/RLS.

## Runbook de reconciliação de vencimento

Uma operação `change_due_date` só entra em `reconciliation_required` quando o
Asaas pode ter recebido a alteração, mas o estado local não pôde ser confirmado.
O `operation_id` retornado pela API é o protocolo da ocorrência.

1. consultar a operação e comparar o vencimento anterior, o pretendido, a
   cobrança e o resultado externo;
2. consultar a cobrança no Asaas sem mutação e comparar com a venda e as
   parcelas locais;
3. corrigir a divergência pela fonte autoritativa escolhida e registrar a
   justificativa;
4. liberar a operação apenas depois da revisão manual;
5. repetir o comando com nova chave de idempotência, se ainda necessário.
